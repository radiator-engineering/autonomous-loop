#!/usr/bin/env node
// spoof_world.mjs — run a FILLED loop driver against a scripted world. Library, not a gate.
//
// The mechanism is selfcheck_loops.mjs's harness(), generalized from "the template we ship" to
// "any filled driver a generation session produced". Same rules: label-keyed routing, a simulated
// disk so the terminal audit is a second reader rather than an echo, verbatim scenario audits.
// One addition each way: promptBytes (lint_design L2 prices ceremony from measured bytes) and
// unknownLabels (eval_driver fails closed on a driver it cannot simulate).
import { readFileSync } from 'node:fs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const EXACT = new Set(['enumerate', 'charter', 'hypothesize', 'poll', 'ledger', 'audit', 'coherence', 'finalize', 'merge'])
const PREFIX = ['critique:', 'find:', 'work:', 'verify:']

export function loadFilledDriver(src) {
  const leftover = [...new Set([...src.matchAll(/<<([A-Z_]+)>>/g)].map(m => m[1]))]
  if (leftover.length) throw new Error(`driver is not filled: ${leftover.join(', ')} — run the FILLED preflight gate`)
  const mode = src.match(/^const MODE = '(\w+)'/m)?.[1]
  if (!mode) throw new Error(`no "const MODE = '<archetype>'" line — not a template-descended driver`)
  const num = (name, fallback) => { const m = src.match(new RegExp(`const ${name} = (\\d+)`)); return m ? Number(m[1]) : fallback }
  const meta = { mode, backstop: num('RUNAWAY_BACKSTOP', 200), patience: num('BLOCKER_PATIENCE', 3), stuckAfter: num('STUCK_AFTER', 2) }
  const body = src.replace('export const meta', 'const meta')
  return { driver: new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'args', body), meta }
}

export function loadFilledDriverFile(path) { return loadFilledDriver(readFileSync(path, 'utf8')) }

// ---- default happy-world responders per archetype (shapes from selfcheck_loops.mjs fixtures) ----
const pass = (id, extra = {}) => ({ id, pass: true, evidence: 'ok', severity: 'none', novel: true, ...extra })
export function fixturesFor(mode) {
  const scn = { verify: id => (mode === 'explorer' ? pass(id, { bears_on: 'q1', finding: 'supports' }) : pass(id)) }
  if (mode === 'exhauster') scn.enumerate = () => ({ items: [{ id: 'i1', task: 't' }, { id: 'i2', task: 't' }, { id: 'i3', task: 't' }] })
  if (mode === 'saturator') scn.find = (lens) => (lens === 'a' || !scn._seen ? (scn._seen = true, { candidates: [{ where: 'c1', claim: 'x' }] }) : { candidates: [] })
  if (mode === 'converger') scn.critique = (n) => ({ total: 2, criteria: [
    { id: 'r1', region: 'r1', status: n === 1 ? 'fail' : 'pass', fix: 'f' },
    { id: 'r2', region: 'r2', status: 'pass', fix: 'f' }] })
  if (mode === 'explorer') {
    scn.charter = () => ({ subquestions: [{ id: 'q1', question: 's1' }, { id: 'q2', question: 's2' }] })
    scn.hypothesize = (n) => (n === 1
      ? { experiments: [{ id: 'e1', subq: 'q1', hypothesis: 'h', method: 'm' }] }
      : { experiments: [{ id: 'ans', subq: 'q1', hypothesis: 'the answer', method: 'm', terminal: true }] })
  }
  if (mode === 'sentinel') scn.poll = (n) => (n === 1 ? { violations: [{ id: 'v1', invariant: 'inv', detail: 'd', severity: 'major' }] } : { violations: [] })
  return scn
}

// ---- the scripted world; scn overrides individual responders exactly as in selfcheck_loops -----
export function spoofWorld(scn) {
  const counts = {}, models = {}, prompts = {}, promptBytes = {}
  const unknownLabels = new Set()
  const disk = { hero: null, handoffRound: null, captures: 0, distinctCaptures: 0 }
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    counts[label] = (counts[label] || 0) + 1
    ;(prompts[label] = prompts[label] || []).push(String(prompt))
    promptBytes[label] = (promptBytes[label] || 0) + Buffer.byteLength(String(prompt))
    if (opts.model) models[label] = opts.model
    const n = counts[label]
    if (label && !EXACT.has(label) && !PREFIX.some(p => label.startsWith(p))) { unknownLabels.add(label); return null }
    if (scn.allDead) return null
    if (label === 'enumerate')         return scn.enumerate ? scn.enumerate() : { items: [] }
    if (label === 'charter')           return scn.charter ? scn.charter() : { subquestions: [] }
    if (label.startsWith('critique:')) return scn.critique ? scn.critique(n, label.slice(9)) : null
    if (label.startsWith('find:'))     return scn.find ? scn.find(label.slice(5), n) : { candidates: [] }
    if (label === 'hypothesize')       return scn.hypothesize ? scn.hypothesize(n) : { experiments: [] }
    if (label === 'poll')              return scn.poll ? scn.poll(n) : { violations: [] }
    if (label.startsWith('work:'))     return scn.work ? scn.work(label.slice(5), n) : 'done'
    if (label.startsWith('verify:'))   return scn.verify ? scn.verify(label.slice(7)) : null
    if (label === 'ledger') {
      const r = scn.ledger ? scn.ledger(n) : { hero: 'artifact', handoff: 'written' }
      if (r && (r.hero === 'artifact' || r.hero === 'none')) disk.hero = r.hero
      if (r && r.hero === 'artifact') { disk.captures++; disk.distinctCaptures++ }
      if (r && r.handoff === 'written') disk.handoffRound = n
      return r
    }
    if (label === 'audit') {
      return scn.audit ? scn.audit(disk, counts['ledger'] || 0)
        : { hero: disk.hero || 'absent',
            handoff: disk.handoffRound === null ? 'absent' : 'complete',
            handoffRound: disk.handoffRound === null ? 0 : disk.handoffRound,
            captures: disk.captures, distinctCaptures: disk.distinctCaptures }
    }
    // MERGE (issue #8 subtask 3): same recovery trick as selfcheck_loops.mjs's harness — the driver
    // names the ids it wants merged right in the prompt text, so the default happy-world responder
    // recovers them from there rather than needing a separate channel. Default: everything requested
    // merges cleanly, so a driver a scenario never overrides for `merge` behaves exactly as it did
    // before this phase existed.
    if (label === 'merge') {
      if (scn.merge) return scn.merge(n, prompt)
      const m = String(prompt).match(/attempt\(s\): (\[[^\]]*\])/)
      const ids = m ? JSON.parse(m[1]) : []
      return { merged: ids, conflicts: [] }
    }
    if (label === 'coherence') return scn.coherence ? scn.coherence() : 'reconciled nothing'
    if (label === 'finalize')  return scn.finalize ? scn.finalize() : { finalized: true }
    return 'ok'   // unlabeled call: the template never relies on an unlabeled call's structure
  }
  const parallel = async (thunks) => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const pipeline = async () => { throw new Error('pipeline not used by template-descended drivers') }
  const budget = scn.budget || { total: null, spent: () => 0, remaining: () => Infinity }
  return { agent, parallel, pipeline, log: () => {}, phase: () => {}, budget, args: undefined,
           counts, models, prompts, promptBytes, disk, unknownLabels }
}
