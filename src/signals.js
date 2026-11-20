/**
 * Turns DSH runtime events into normalized usage signals. This module contains
 * no inference logic: it only observes and attributes.
 */
export function createSignalHub(ctx, {
  attribution,
  emit,
  exposureTargets = () => [],
  findByToolSnapshot = () => null,
  config = {},
} = {}) {
  /** @type {WeakMap<object, {users: number, finalized: boolean}>} */
  const sessions = new WeakMap()

  function trackSession(session, event) {
    let record = sessions.get(session)
    if (!record) {
      record = { users: 0, finalized: false }
      sessions.set(session, record)
    }
    if (event.type === 'user/message') record.users += 1
    return record
  }

  function finalizeExposure(record) {
    if (record.finalized || record.users < 2) return
    record.finalized = true
    for (const target of exposureTargets()) {
      emit({ pluginKey: target.key, kind: 'exposure', detail: 'effective user session' })
    }
  }

  ctx.on('session/event', (session, event) => {
    if (!event || !session) return
    const type = event.type
    const data = event.data ?? {}

    if (type === 'user/message') {
      trackSession(session, event)
      return
    }

    if (type === 'assistant/message') {
      const record = sessions.get(session)
      if (record) finalizeExposure(record)
      return
    }

    if (type === 'tool/call') {
      const name = data.name
      if (!name) return
      const owner = attribution.resolve('tool', name)
      if (owner) {
        emit({ pluginKey: owner.moduleName, kind: 'tool', detail: name })
      } else {
        // A tool name in a disabled plugin's snapshot that the model still
        // tries to call is the strongest possible "we killed something useful"
        // signal.
        const disabledOwner = findByToolSnapshot(name)
        if (disabledOwner) {
          emit({ pluginKey: disabledOwner.key, kind: 'missing_tool', detail: name, toolNames: [name] })
        }
      }
      return
    }

    if (type === 'command/run') {
      const name = data.name
      if (!name) return
      const owner = attribution.resolve('command', name) ?? attribution.resolve('tool', name)
      if (owner) emit({ pluginKey: owner.moduleName, kind: 'command', detail: name })
      return
    }

    if (type === 'hook/invoked') {
      const id = data.handlerId
      if (!id) return
      const owner = attribution.resolve('hook', id) ?? attribution.resolve('command', id)
      if (owner) emit({ pluginKey: owner.moduleName, kind: 'hook', detail: id })
      return
    }

    if (type === 'feedback/record' && config.probeFeedback !== false) {
      const category = data.category ?? 'other'
      if (category === 'service-stability' || category === 'task-result') {
        // Applied by the engine only to plugins currently in probation.
        emit({ pluginKey: '*', kind: 'feedback', detail: category })
      }
    }
  })

  ctx.on('session/disposed', session => {
    const record = sessions.get(session)
    if (record) finalizeExposure(record)
  })

  return { trackSession, finalizeExposure }
}
