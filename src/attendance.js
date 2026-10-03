const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');
const { participantDetails } = require('./schedules');

/**
 * 到场登记：导演为“有效”排练时段开启的一次性签到登记。
 *
 * 核心规则：
 *   - 仅 status=active 的时段可开启；每个时段至多一次登记
 *     （已取消/待调整 -> 400；已有登记 -> 409 ATTENDANCE_EXISTS）。
 *   - 开启时冻结：场次、UTC 时段、排练当前固定版本、当时本场有台词且已派角的演员名单（应到）；
 *     有台词但未派角的角色记为“缺口”，仅展示，不计应到。
 *   - 名单内演员仅能在开放期为本人签到；重复签到返回首次结果（幂等）。
 *   - 导演关闭后，未签到者记缺席；之后再签到、再关闭均拒绝（409 ATTENDANCE_CLOSED）。
 *   - 改派/换版/调整日程不回写名单与签到；开启后加入的演员不能签到该次登记（403）。
 *   - 开放期内日程被取消 -> 登记作废（void，由 schedules.js 取消时维护）：停止签到，
 *     保留签到痕迹但不计出勤（stats.counted=false）；
 *     关闭后日程被取消 -> 仅标注 scheduleCancelled，原统计保留。
 *   - 导演可见名单/缺口/统计；演员仅见本人记录。
 *
 * 依赖方向：本模块单向引用 schedules.js 的 participantDetails，schedules.js 不引用本模块
 * （取消时段时对开放登记的作废处理内联在 schedules.js 中，避免循环依赖）。
 */

const router = express.Router();
router.use(authRequired);

// ---- 本地小工具 ----
function getRehearsalOrThrow(id) {
  const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(id);
  if (!r) throw notFound('排练不存在');
  return r;
}

function getScheduleOrThrow(scheduleId, rehearsalId) {
  const s = db
    .prepare('SELECT * FROM rehearsal_schedules WHERE id = ? AND rehearsal_id = ?')
    .get(scheduleId, rehearsalId);
  if (!s) throw notFound('日程安排不存在');
  return s;
}

function getSessionOrThrow(scheduleId) {
  const row = db.prepare('SELECT * FROM attendance_sessions WHERE schedule_id = ?').get(scheduleId);
  if (!row) throw notFound('该时段尚未开启到场登记');
  return row;
}

function getRosterEntry(sessionId, actorId) {
  return db
    .prepare('SELECT * FROM attendance_roster WHERE session_id = ? AND actor_id = ?')
    .get(sessionId, actorId);
}

/** 名单成员在登记当前状态下的出勤标记 */
function attendanceOf(session, checkedInAt) {
  if (session.status === 'void') return 'void'; // 作废：checkedInAt 仅作痕迹保留，不计出勤
  if (checkedInAt) return 'present';
  return session.status === 'closed' ? 'absent' : 'pending';
}

/** 公共视图：冻结的场次/版本/UTC 时段 + 日程当前状态标注 */
function baseView(session, schedule) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(session.scene_id);
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(session.version_id);
  return {
    id: session.id,
    scheduleId: session.schedule_id,
    rehearsalId: session.rehearsal_id,
    sceneId: session.scene_id,
    sceneCode: scene?.code ?? null,
    sceneTitle: scene?.title ?? null,
    versionId: session.version_id,
    versionNo: version?.version_no ?? null,
    startAt: session.start_at, // 冻结的 UTC 时段，不随日程调整而变
    endAt: session.end_at,
    status: session.status,
    scheduleStatus: schedule.status,
    scheduleCancelled: schedule.status === 'cancelled', // 关闭后日程被取消的标注（原统计保留）
    openedBy: session.opened_by,
    openedAt: session.opened_at,
    closedAt: session.closed_at,
    voidedAt: session.voided_at,
  };
}

/** 导演视图：冻结名单 + 缺口 + 状态统计 */
function serializeForDirector(session, schedule) {
  const roster = db
    .prepare(
      `SELECT ar.*, u.display_name, u.username
         FROM attendance_roster ar
         JOIN users u ON u.id = ar.actor_id
        WHERE ar.session_id = ? ORDER BY ar.id`
    )
    .all(session.id)
    .map((row) => ({
      actorId: row.actor_id,
      actorName: row.display_name,
      actorUsername: row.username,
      roles: JSON.parse(row.roles_json),
      checkedInAt: row.checked_in_at,
      attendance: attendanceOf(session, row.checked_in_at),
    }));
  const gaps = db
    .prepare(
      `SELECT g.role_id, ro.code, ro.name
         FROM attendance_gaps g
         JOIN roles ro ON ro.id = g.role_id
        WHERE g.session_id = ? ORDER BY g.id`
    )
    .all(session.id)
    .map((g) => ({ roleId: g.role_id, roleCode: g.code, roleName: g.name }));
  const expected = roster.length;
  const present = roster.filter((x) => x.checkedInAt).length;
  const stats =
    session.status === 'void'
      ? // 作废：保留签到痕迹（present 为痕迹数），不计出勤
        { expected, present, absent: 0, pending: 0, counted: false }
      : session.status === 'closed'
        ? { expected, present, absent: expected - present, pending: 0, counted: true }
        : { expected, present, absent: 0, pending: expected - present, counted: true };
  return { ...baseView(session, schedule), gaps, roster, stats };
}

/** 演员视图：仅本人记录（开启后才加入的演员 onRoster=false） */
function serializeForActor(session, schedule, entry) {
  return {
    ...baseView(session, schedule),
    myRecord: entry
      ? {
          onRoster: true,
          roles: JSON.parse(entry.roles_json),
          checkedInAt: entry.checked_in_at,
          attendance: attendanceOf(session, entry.checked_in_at),
        }
      : { onRoster: false },
  };
}

// ---- 导演：开启登记（冻结场次/UTC时段/固定版本/应到名单；未派角角色记为缺口） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/attendance',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    if (s.status === 'cancelled') throw badRequest('已取消的时段不能开启到场登记');
    if (s.status === 'needs_adjustment') throw badRequest('待调整的时段不能开启到场登记，请先调整恢复有效');
    const existing = db
      .prepare('SELECT id FROM attendance_sessions WHERE schedule_id = ?')
      .get(s.id);
    if (existing) {
      throw conflict('ATTENDANCE_EXISTS', '该时段已开启过到场登记（每个时段仅一次）', {
        attendanceId: existing.id,
      });
    }

    // 冻结：当时固定版本中本场有台词且已派角的演员 -> 应到名单；未派角角色 -> 缺口
    const { participants, pendingCast } = participantDetails(r.id, r.version_id, s.scene_id);
    const now = new Date().toISOString();
    const sessionId = transaction(() => {
      const sid = db
        .prepare(
          `INSERT INTO attendance_sessions
             (schedule_id, rehearsal_id, scene_id, version_id, start_at, end_at, opened_by, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(s.id, r.id, s.scene_id, r.version_id, s.start_at, s.end_at, req.user.id, now).lastInsertRowid;
      const insRoster = db.prepare(
        'INSERT INTO attendance_roster (session_id, actor_id, roles_json) VALUES (?, ?, ?)'
      );
      for (const p of participants) insRoster.run(sid, p.actorId, JSON.stringify(p.roles));
      const insGap = db.prepare('INSERT INTO attendance_gaps (session_id, role_id) VALUES (?, ?)');
      for (const g of pendingCast) insGap.run(sid, g.roleId);
      return sid;
    });

    const session = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(sessionId);
    res.status(201).json({ attendance: serializeForDirector(session, s) });
  })
);

// ---- 查看：导演看名单/缺口/统计；演员仅本人记录 ----
router.get(
  '/rehearsals/:id/schedules/:scheduleId/attendance',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    const session = getSessionOrThrow(s.id);
    if (req.user.role === 'director') {
      return res.json({ attendance: serializeForDirector(session, s) });
    }
    const entry = getRosterEntry(session.id, req.user.id);
    if (!entry) {
      // 名单外演员：仅当前仍被派角者可看到“不在名单”的本人视图（后来加入者不能签到）；
      // 与该排练无关的演员一律 403
      const castNow = db
        .prepare('SELECT 1 FROM rehearsal_cast WHERE rehearsal_id = ? AND actor_id = ? LIMIT 1')
        .get(r.id, req.user.id);
      if (!castNow) throw forbidden();
    }
    res.json({ attendance: serializeForActor(session, s, entry) });
  })
);

// ---- 演员：开放期为本人签到（名单在开启时冻结；重试返回首次签到结果） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/attendance/checkin',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅名单内演员本人可以签到');
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    const session = getSessionOrThrow(s.id);
    if (session.status === 'closed') {
      throw conflict('ATTENDANCE_CLOSED', '登记已关闭，未签到者已记缺席，无法再签到');
    }
    if (session.status === 'void') {
      throw conflict('ATTENDANCE_VOID', '该时段已在开放期取消，登记作废，签到停止');
    }
    const entry = getRosterEntry(session.id, req.user.id);
    if (!entry) {
      throw forbidden('你不在本次登记的应到名单中（名单于开启时冻结，后续派角不计入）');
    }
    if (entry.checked_in_at) {
      // 幂等重试：返回首次签到结果，不更新时间
      return res.json({ ok: true, alreadyCheckedIn: true, checkedInAt: entry.checked_in_at });
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE attendance_roster SET checked_in_at = ? WHERE id = ?').run(now, entry.id);
    res.json({ ok: true, alreadyCheckedIn: false, checkedInAt: now });
  })
);

// ---- 导演：关闭登记（未签到者记缺席；再次关闭拒绝） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/attendance/close',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    const session = getSessionOrThrow(s.id);
    if (session.status === 'closed') throw conflict('ATTENDANCE_CLOSED', '登记已关闭，不能重复关闭');
    if (session.status === 'void') {
      throw conflict('ATTENDANCE_VOID', '登记已作废（时段在开放期被取消），不能关闭');
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE attendance_sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(
      now,
      session.id
    );
    const fresh = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(session.id);
    res.json({ ok: true, attendance: serializeForDirector(fresh, s) });
  })
);

module.exports = { router };
