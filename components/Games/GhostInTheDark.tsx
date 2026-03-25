// Game engine for "Ghost in the Dark" - TypeScript module
// Exported class: GhostInTheDarkGame
// Event callbacks are provided through the options parameter.

type ID = string;

type Position2D = { x: number; y: number };
type Position3D = { x: number; y: number; z: number };

export type RoleName =
  | "ghost"
  | "angel"
  | "detective"
  | "haunter"
  | "sheriff"
  | "whisperer"
  | "spirit"
  | "president"
  | "murderer"
  | "lawyer"
  | "civilian";

export interface Player {
  id: ID;
  name: string;
  role: RoleName;
  alive: boolean;
  deadAt?: number;
  isResurrected?: boolean;
  meetingCallRemaining: number;
  meetingsCalled: number;
  canChatDuringMeeting: boolean; // false for resurrected players per spec
  // role-specific state:
  lastKillAt?: number;
  lastShotAt?: number;
  spiritUsesRemaining?: number;
  murdererHasKilled?: boolean;
  detectiveUsed?: boolean;
  lawyerUsed?: boolean;
  // optional position in 3D space (engine/consumer can set)
  position?: Position3D;
}

export interface Report {
  reporterId: ID;
  victimId: ID;
  // location can now be a 3D point, a legacy 2D point, or a string descriptor
  location?: Position3D | Position2D | string | null;
  time: number;
}

export interface GameOptions {
  roles?: RoleName[]; // optional explicit role list; otherwise assigned randomly based on player count
  onJumpscare?: (victim: Player, killer: Player | null) => void;
  onPlayerKilled?: (victim: Player, killer: Player | null) => void;
  onPlayerRevived?: (player: Player, reviver: Player) => void;
  onMeetingCalled?: (caller: Player, report?: Report) => void;
  onMeetingPhaseChanged?: (phase: "discussion" | "voting", startedAt: number, durationMs: number) => void;
  onMeetingEnded?: (result: { ejectedId?: ID | null; winner?: "ghost" | "other" | null }) => void;
  onGameEnd?: (winner: "ghost" | "other") => void;
  now?: () => number; // for testing/time control, defaults to Date.now()
  discussionDurationMs?: number; // chat time
  voteDurationMs?: number; // voting time

  // skull/visibility options:
  skullVisibleDistance?: number; // default distance within which skulls are visible to non-whisperers
  // optional override to implement LOS/walls logic. If provided it must return true when viewer can see skull.
  canSeeSkull?: (viewer: Player, skull: Skull) => boolean;
}

/**
 * Skull marker left at a death location to signal a reportable body.
 * reportedAt is set when someone reports it (meeting triggered); skulls persist unless removed by consumer.
 */
export interface Skull {
  id: string;
  victimId: ID;
  position?: Position3D;
  createdAt: number;
  reportedAt?: number | null;
}

/**
 * Core game class. Authoritative state should live on the server when used in multiplayer.
 * This is intentionally implementation-focused but event-driven so UI/network code can subscribe.
 *
 * This update adds skull markers (bodies) placed at deaths; skulls can be reported to call meetings. Whisperer
 * can see skulls through walls by default. Visibility can be customized via GameOptions.canSeeSkull.
 */
export class GhostInTheDarkGame {
  players: Map<ID, Player> = new Map();
  options: GameOptions;
  roleOrder: RoleName[] = [];
  inMeeting: boolean = false;
  meetingStartedAt?: number;
  meetingReport?: Report | null = null;
  votes: Map<ID, ID | null> = new Map(); // voterId -> targetId | null (skip)
  meetingCallerId?: ID | null;
  gameOver: boolean = false;
  ghostId?: ID | null;

  // meeting phase: 'discussion' | 'voting' | undefined
  meetingPhase?: "discussion" | "voting";

  // timers
  private _discussionTimeout?: ReturnType<typeof setTimeout>;
  private _voteTimeout?: ReturnType<typeof setTimeout>;

  // tuning values
  ghostKillCooldownMs = 30_000;
  haunterKillCooldownMs = 60_000;
  spiritPhaseDurationMs = 15_000;
  spiritMaxUses = 3;

  // skull storage
  private _skulls: Map<string, Skull> = new Map();

  constructor(players: { id: ID; name: string }[], options: GameOptions = {}) {
    this.options = {
      now: () => Date.now(),
      discussionDurationMs: 20_000, // chatting time
      voteDurationMs: 30_000, // voting time
      skullVisibleDistance: 5, // default units
      ...options,
    };

    // Create default player objects
    players.forEach((p) => {
      const pl: Player = {
        id: p.id,
        name: p.name,
        role: "civilian",
        alive: true,
        meetingCallRemaining: 1, // each player may call meetings ONCE by default
        meetingsCalled: 0,
        canChatDuringMeeting: true,
        spiritUsesRemaining: this.spiritMaxUses,
      };
      this.players.set(p.id, pl);
    });

    // If roles provided explicitly, assign them (must match players length)
    if (options.roles && options.roles.length === players.length) {
      let i = 0;
      for (const p of players) {
        const role = options.roles![i++];
        const pl = this.players.get(p.id)!;
        pl.role = role;
        // special inits
        this._initRoleState(pl);
        if (role === "ghost") this.ghostId = p.id;
      }
    }
  }

  // Basic helpers
  now() {
    return (this.options.now || (() => Date.now()))();
  }

  getAlivePlayers(): Player[] {
    return Array.from(this.players.values()).filter((p) => p.alive);
  }

  getPlayer(id: ID): Player | undefined {
    return this.players.get(id);
  }

  // Initialize role-specific fields
  _initRoleState(p: Player) {
    switch (p.role) {
      case "ghost":
        p.lastKillAt = 0;
        break;
      case "haunter":
        p.lastKillAt = 0;
        break;
      case "spirit":
        p.spiritUsesRemaining = this.spiritMaxUses;
        break;
      case "murderer":
        p.murdererHasKilled = false;
        break;
      case "detective":
        p.detectiveUsed = false;
        break;
      case "lawyer":
        p.lawyerUsed = false;
        break;
      case "president":
        p.meetingCallRemaining = 5;
        break;
      default:
        break;
    }
  }

  // Assign roles randomly (helper) - simple distribution, can be customized
  assignRoles(roleList: RoleName[]) {
    const players = Array.from(this.players.values());
    if (roleList.length !== players.length) {
      throw new Error("roleList length must equal number of players");
    }
    for (let i = 0; i < players.length; i++) {
      players[i].role = roleList[i];
      this._initRoleState(players[i]);
      if (players[i].role === "ghost") this.ghostId = players[i].id;
    }
  }

  // ---------- Skull visibility helpers ----------

  private _toPosition3D(loc?: Position3D | Position2D | string | null): Position3D | undefined {
    if (!loc || typeof loc === "string") return undefined;
    // Assume if z missing, z = 0
    const asAny = loc as any;
    return { x: asAny.x, y: asAny.y, z: asAny.z ?? 0 };
  }

  private _distance(a: Position3D, b: Position3D) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private _isSkullVisibleTo(viewer: Player, skull: Skull): boolean {
    // If consumer provided a custom visibility function, use it
    if (this.options.canSeeSkull) {
      try {
        return this.options.canSeeSkull(viewer, skull);
      } catch (e) {
        // fallback to built-in behavior on error
      }
    }

    // Whisperer can see skulls through walls (i.e., ignore distance)
    if (viewer.role === "whisperer" && viewer.alive) return true;

    // If skull has no position, it's not visible by default
    if (!skull.position) return false;

    // If viewer has no position, cannot determine visibility; default to false
    if (!viewer.position) return false;

    const distance = this._distance(viewer.position, skull.position);
    const threshold = this.options.skullVisibleDistance ?? 5;
    return distance <= threshold && viewer.alive;
  }

  // Return skulls visible to a particular player. If no viewer provided, return all skulls.
  getVisibleSkulls(viewerId?: ID): Skull[] {
    const skulls = Array.from(this._skulls.values());
    if (!viewerId) return skulls;
    const viewer = this.getPlayer(viewerId);
    if (!viewer) return [];
    return skulls.filter((s) => this._isSkullVisibleTo(viewer, s));
  }

  // Return all skulls (admin usage)
  getAllSkulls(): Skull[] {
    return Array.from(this._skulls.values());
  }

  // Report a skull to call a meeting. Reporter must be alive and able to see the skull.
  reportSkull(reporterId: ID, skullId: string) {
    if (this.gameOver) return;
    const reporter = this.getPlayer(reporterId);
    if (!reporter || !reporter.alive) throw new Error("Only alive players can report skulls");
    const skull = this._skulls.get(skullId);
    if (!skull) throw new Error("Invalid skull id");
    // Must be visible to reporter
    if (!this._isSkullVisibleTo(reporter, skull)) throw new Error("Skull not visible to reporter");

    // mark reported
    skull.reportedAt = this.now();
    this._skulls.set(skull.id, skull);

    // call meeting with skull location + victim
    return this.callMeeting(reporterId, { victimId: skull.victimId, location: skull.position ?? null });
  }

  // ---------- Meeting / reporting / voting ----------

  // Call a meeting: any player may call once (meetingCallRemaining) unless president who may call up to 5
  // Now includes a discussion phase (chat) followed by a voting phase.
  callMeeting(
    callerId: ID,
    report?: { victimId: ID; location?: Position3D | Position2D | string | null }
  ) {
    if (this.gameOver) return;
    const caller = this.getPlayer(callerId);
    if (!caller || !caller.alive) throw new Error("Only alive players can call meetings/report");
    if (caller.meetingCallRemaining <= 0) {
      throw new Error("No meeting calls remaining for this player");
    }
    // decrement call remaining
    caller.meetingCallRemaining = Math.max(0, caller.meetingCallRemaining - 1);
    caller.meetingsCalled += 1;

    // Clear existing timers if any
    if (this._discussionTimeout) clearTimeout(this._discussionTimeout);
    if (this._voteTimeout) clearTimeout(this._voteTimeout);

    this.inMeeting = true;
    this.meetingStartedAt = this.now();
    this.meetingReport = report
      ? { reporterId: callerId, victimId: report.victimId, location: report.location ?? null, time: this.now() }
      : null;
    this.meetingCallerId = callerId;
    this.votes.clear();

    // Reset voting/chat restrictions for resurrected players: they cannot chat during meetings
    Array.from(this.players.values()).forEach((pl) => {
      if (pl.isResurrected) {
        pl.canChatDuringMeeting = false;
      } else {
        pl.canChatDuringMeeting = true;
      }
    });

    // Set initial phase: discussion
    this.meetingPhase = "discussion";
    const discussionMs = this.options.discussionDurationMs ?? 20_000;
    this.options.onMeetingCalled?.(caller, this.meetingReport || undefined);
    this.options.onMeetingPhaseChanged?.("discussion", this.meetingStartedAt!, discussionMs);

    // After discussion time, start voting automatically
    this._discussionTimeout = setTimeout(() => {
      if (!this.inMeeting) return;
      this._startVotingPhase();
    }, discussionMs);
  }

  private _startVotingPhase() {
    if (!this.inMeeting) return;
    this.meetingPhase = "voting";
    const started = this.now();
    const voteMs = this.options.voteDurationMs ?? 30_000;
    this.options.onMeetingPhaseChanged?.("voting", started, voteMs);

    // Auto-end voting after voteDurationMs
    this._voteTimeout = setTimeout(() => {
      if (this.inMeeting) this.endMeeting();
    }, voteMs);
  }

  reportBody(reporterId: ID, victimId: ID, location?: Position3D | Position2D | string | null) {
    // reporting is a type of meeting call
    return this.callMeeting(reporterId, { victimId, location });
  }

  // Voting API: vote targetId === null -> skip. Votes only counted if in meeting and in voting phase and voter alive.
  vote(voterId: ID, targetId: ID | null) {
    if (!this.inMeeting || this.meetingPhase !== "voting") throw new Error("Voting is only allowed during the voting phase");
    const voter = this.getPlayer(voterId);
    if (!voter || !voter.alive) throw new Error("Only alive players may vote");
    // if lawyer forced votes will be applied externally via forceVote (see below)
    this.votes.set(voterId, targetId);
  }

  // End meeting and tally votes
  endMeeting() {
    if (!this.inMeeting) return;
    this.inMeeting = false;

    // Clear timers
    if (this._discussionTimeout) {
      clearTimeout(this._discussionTimeout);
      this._discussionTimeout = undefined;
    }
    if (this._voteTimeout) {
      clearTimeout(this._voteTimeout);
      this._voteTimeout = undefined;
    }

    // Tally: targetId -> count (treat non-voters as skip/null)
    const tally = new Map<string | null, number>();
    for (const p of this.getAlivePlayers()) {
      const v = this.votes.get(p.id) ?? null;
      tally.set(v, (tally.get(v) ?? 0) + 1);
    }

    // Find highest count. Tie-breaker: skip/null wins ties (no ejection).
    let max = -1;
    let ejected: ID | null = null;
    let tied = false;
    for (const [target, count] of tally.entries()) {
      if (count > max) {
        max = count;
        ejected = target as ID | null;
        tied = false;
      } else if (count === max) {
        tied = true;
      }
    }

    if (tied || ejected === null) {
      // skip / tie => no ejection
      this.options.onMeetingEnded?.({ ejectedId: null, winner: null });
      this._maybeCheckEndConditions();
      return;
    }

    const targetPlayer = this.getPlayer(ejected);
    if (!targetPlayer) {
      this.options.onMeetingEnded?.({ ejectedId: null, winner: null });
      this._maybeCheckEndConditions();
      return;
    }

    // Eject the player
    this._killPlayer(ejected, null, { ejected: true });

    // If the ejected was the ghost -> others win
    if (targetPlayer.role === "ghost") {
      this.gameOver = true;
      this.options.onMeetingEnded?.({ ejectedId: ejected, winner: "other" });
      this.options.onGameEnd?.("other");
      return;
    } else {
      this.options.onMeetingEnded?.({ ejectedId: ejected, winner: null });
    }

    this._maybeCheckEndConditions();
  }

  // Attempt to kill a player (per role rules)
  attemptKill(killerId: ID, targetId: ID) {
    if (this.gameOver) return;
    const killer = this.getPlayer(killerId);
    const target = this.getPlayer(targetId);
    if (!killer || !target || !killer.alive || !target.alive) throw new Error("Invalid killer/target");
    const now = this.now();

    // Disallow kills during meetings
    if (this.inMeeting) throw new Error("Cannot kill during meetings");

    switch (killer.role) {
      case "ghost": {
        const last = killer.lastKillAt ?? 0;
        if (now - last < this.ghostKillCooldownMs) throw new Error("Ghost kill on cooldown");
        killer.lastKillAt = now;
        this._killPlayer(targetId, killerId);
        break;
      }
      case "haunter": {
        // special: haunter can only kill when it is dead
        if (killer.alive) throw new Error("Haunter can only kill while dead");
        const last = killer.lastKillAt ?? 0;
        if (now - last < this.haunterKillCooldownMs) throw new Error("Haunter kill on cooldown");
        killer.lastKillAt = now;
        this._killPlayer(targetId, killerId);
        break;
      }
      case "murderer": {
        if (killer.murdererHasKilled) throw new Error("Murderer can kill only once");
        killer.murdererHasKilled = true;
        this._killPlayer(targetId, killerId);
        break;
      }
      default:
        throw new Error("This role cannot perform kills (use role-specific actions)");
    }

    this._maybeCheckEndConditions();
  }

  // Sheriff shoot action
  sheriffShoot(shooterId: ID, targetId: ID) {
    const shooter = this.getPlayer(shooterId);
    const target = this.getPlayer(targetId);
    if (!shooter || shooter.role !== "sheriff" || !shooter.alive) throw new Error("Invalid shooter");
    if (!target || !target.alive) throw new Error("Invalid target");

    // Shooting is immediate: if target is ghost -> ghost dies and others win; if not -> shooter dies
    if (target.role === "ghost") {
      this._killPlayer(targetId, shooterId);
      // Ghost shot by sheriff -> others win
      this.gameOver = true;
      this.options.onGameEnd?.("other");
    } else {
      // Wrong shot -> sheriff dies
      this._killPlayer(shooterId, targetId);
    }

    this._maybeCheckEndConditions();
  }

  // Detective ability: one-time ask anyone's role
  detectiveAsk(detId: ID, targetId: ID) {
    const det = this.getPlayer(detId);
    const target = this.getPlayer(targetId);
    if (!det || det.role !== "detective" || !det.alive) throw new Error("Invalid detective");
    if (!target) throw new Error("Invalid target");
    if (det.detectiveUsed) throw new Error("Detective ability already used");
    det.detectiveUsed = true;
    return target.role; // reply to caller (UI should keep secret)
  }

  // Angel revive: can revive one person once they die, cannot revive self.
  angelRevive(angelId: ID, targetId: ID) {
    const angel = this.getPlayer(angelId);
    const target = this.getPlayer(targetId);
    if (!angel || angel.role !== "angel" || !angel.alive) throw new Error("Invalid angel");
    if (!target) throw new Error("Invalid target");
    if (target.id === angel.id) throw new Error("Angel cannot revive themselves");
    if (target.alive) throw new Error("Target must be dead to revive");
    if ((angel as any).reviveUsed) throw new Error("Angel revive already used");
    (angel as any).reviveUsed = true;

    // Revive immediately
    target.alive = true;
    target.isResurrected = true;
    target.deadAt = undefined;
    // Resurrected player cannot chat during meetings (requirement)
    target.canChatDuringMeeting = false;

    this.options.onPlayerRevived?.(target, angel);
  }

  // Whisperer: talk to dead (receives chat from dead) and see death locations
  // For the engine, we provide a method to fetch death logs and a method to send whisper messages.
  getDeathReports(): Report[] {
    return (this as any)._deathReports ?? [];
  }

  // Spirit: travel through walls up to 3 times per game for 15s each (works in 3D space now)
  spiritPhase(spiritId: ID) {
    const spirit = this.getPlayer(spiritId);
    if (!spirit || spirit.role !== "spirit") throw new Error("Invalid spirit");
    if (!spirit.alive) throw new Error("Spirit must be alive to enter phase");
    if ((spirit.spiritUsesRemaining ?? 0) <= 0) throw new Error("No spirit uses remaining");
    spirit.spiritUsesRemaining = (spirit.spiritUsesRemaining ?? 0) - 1;

    // Consumer/UI must allow mounting wall-pass mode for spiritPhaseDurationMs
    setTimeout(() => {
      // phase ends automatically
    }, this.spiritPhaseDurationMs);

    return { durationMs: this.spiritPhaseDurationMs, remainingUses: spirit.spiritUsesRemaining };
  }

  // Lawyer: force one person to vote for someone else or to skip voting. One-time use.
  lawyerForceVote(lawyerId: ID, targetPlayerIdToForce: ID, forcedVoteFor: ID | null) {
    const lawyer = this.getPlayer(lawyerId);
    if (!lawyer || lawyer.role !== "lawyer" || !lawyer.alive) throw new Error("Invalid lawyer");
    if (lawyer.lawyerUsed) throw new Error("Lawyer ability already used");
    lawyer.lawyerUsed = true;
    // Apply force: set in votes map (only valid during voting phase)
    if (!this.inMeeting || this.meetingPhase !== "voting") throw new Error("Forcing votes only during voting phase");
    this.votes.set(targetPlayerIdToForce, forcedVoteFor);
  }

  // Force vote utility used by lawyer or external admin
  forceVote(targetId: ID, forced: ID | null) {
    if (!this.inMeeting || this.meetingPhase !== "voting") throw new Error("No voting phase in progress");
    this.votes.set(targetId, forced);
  }

  // Internal: apply a kill, mark death time, trigger jumpscare event for victim
  _killPlayer(
    victimId: ID,
    killerId: ID | null,
    opts?: { ejected?: boolean; location?: Position3D | Position2D | string | null }
  ) {
    const victim = this.getPlayer(victimId);
    if (!victim || !victim.alive) return;
    victim.alive = false;
    victim.deadAt = this.now();

    // store death location info in a global array for whisperer (for integration)
    const deathReports = (this as any)._deathReports ?? [];
    deathReports.push({
      reporterId: killerId ?? "system",
      victimId,
      location: (opts && (opts as any).location) ?? null,
      time: victim.deadAt,
    });
    (this as any)._deathReports = deathReports;

    // Create a skull (body marker) if we have numeric location (2D or 3D)
    const pos3d = this._toPosition3D(opts?.location);
    if (pos3d) {
      const skullId = `${victimId}-${this.now()}`;
      const skull: Skull = {
        id: skullId,
        victimId,
        position: pos3d,
        createdAt: this.now(),
        reportedAt: null,
      };
      this._skulls.set(skullId, skull);
    }

    // Jumpscare: only when killer role === ghost
    const killer = killerId ? this.getPlayer(killerId) : null;
    if (killer && killer.role === "ghost") {
      this.options.onJumpscare?.(victim, killer);
    }

    this.options.onPlayerKilled?.(victim, killer);

    // After dying, check end conditions
    this._maybeCheckEndConditions();
  }

  // Check end conditions:
  // - If ghost is ejected -> others win (handled at ejection)
  // - If only two players remain (the Ghost and anyone else), the game ends, and the Ghost wins.
  _maybeCheckEndConditions() {
    if (this.gameOver) return;
    const alive = this.getAlivePlayers();
    if (alive.length === 0) {
      // No one alive - edge case: others win by default
      this.gameOver = true;
      this.options.onGameEnd?.("other");
      return;
    }
    // If ghost alive and number of alive players === 2 and one of them is the ghost -> ghost wins
    const ghostAlive = Array.from(this.players.values()).some((p) => p.alive && p.role === "ghost");
    if (ghostAlive && alive.length === 2) {
      this.gameOver = true;
      this.options.onGameEnd?.("ghost");
      return;
    }

    // If ghost dead, others win - handled elsewhere
  }

  // Utility: returns a snapshot useful for clients (excluding secret info unless requested)
  // Snapshot now includes skulls visible to the requesting player (so the client can render bodies).
  snapshot(forPlayerId?: ID) {
    const selfId = forPlayerId;
    const visibleSkulls = forPlayerId ? this.getVisibleSkulls(forPlayerId) : this.getAllSkulls();
    return {
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        role: p.id === selfId ? p.role : p.alive ? "unknown" : (p.role === "ghost" && !p.alive ? "dead" : "dead"),
        alive: p.alive,
        isResurrected: p.isResurrected ?? false,
        meetingCallRemaining: p.meetingCallRemaining,
      })),
      skulls: visibleSkulls.map((s) => ({
        id: s.id,
        victimId: s.victimId,
        position: s.position,
        createdAt: s.createdAt,
        reportedAt: s.reportedAt ?? null,
      })),
      inMeeting: this.inMeeting,
      meetingPhase: this.meetingPhase,
      meetingReport: this.meetingReport ? { ...this.meetingReport, reporterId: this.meetingReport.reporterId } : null,
      gameOver: this.gameOver,
    };
  }
}