import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWriteFileStreamingReporter,
  summarizeWriteFileProgress,
} from './writeFileStreaming.mjs'

test('summarizeWriteFileProgress reads incomplete streamed write_file arguments', () => {
  const rawArgs =
    '{"path":"prototype/index.html","content":"<!doctype html>\\n<html>'

  assert.deepEqual(summarizeWriteFileProgress(rawArgs), {
    stage: 'edit_transaction_preview',
    phase: 'streaming_preview',
    operation: 'write_file_streaming',
    affectedPaths: ['prototype/index.html'],
    operations: [
      {
        kind: 'write',
        path: 'prototype/index.html',
      },
    ],
    filePath: 'prototype/index.html',
    contentBytes: 22,
    contentChars: 22,
    complete: false,
    summary: 'Generating write_file content for prototype/index.html (22 B).',
  })
})

test('summarizeWriteFileProgress marks complete JSON arguments as complete', () => {
  const rawArgs = JSON.stringify({
    path: 'src/app.css',
    content: 'body { color: red; }\n',
  })

  const progress = summarizeWriteFileProgress(rawArgs)

  assert.equal(progress.phase, 'streaming_complete')
  assert.equal(progress.complete, true)
  assert.equal(progress.contentBytes, 21)
  assert.equal(progress.summary, 'Generated write_file content for src/app.css (21 B).')
})

test('createWriteFileStreamingReporter emits by file and content size bucket', () => {
  const events = []
  const reporter = createWriteFileStreamingReporter({
    order: 7,
    hooks: {
      onToolEvent(event) {
        events.push(event)
      },
    },
  })
  const toolCall = {
    id: 'call-write',
    index: 0,
    function: {
      name: 'write_file',
      arguments: '{"path":"src/a.html","content":"small',
    },
  }

  reporter.inspect([toolCall])
  reporter.inspect([toolCall])
  toolCall.function.arguments = `{"path":"src/a.html","content":"${'x'.repeat(5000)}`
  reporter.inspect([toolCall])

  assert.equal(events.length, 2)
  assert.equal(events[0].id, events[1].id)
  assert.equal(events[0].name, 'write_file')
  assert.equal(events[0].status, 'running')
  assert.equal(events[0].order, 7)
  assert.equal(JSON.parse(events[1].output).contentBytes, 5000)
})

test('createWriteFileStreamingReporter marks complete write_file arguments successful', () => {
  const events = []
  const reporter = createWriteFileStreamingReporter({
    hooks: {
      onToolEvent(event) {
        events.push(event)
      },
    },
  })

  reporter.inspect([
    {
      id: 'call-write',
      index: 0,
      function: {
        name: 'write_file',
        arguments: '{"path":"src/a.html","content":"done"}',
      },
    },
  ])

  assert.equal(events.length, 1)
  assert.equal(events[0].status, 'success')
  assert.equal(events[0].finishedAt > 0, true)
  assert.equal(JSON.parse(events[0].output).complete, true)
})

test('createWriteFileStreamingReporter can fail open previews on stream interruption', () => {
  const events = []
  const reporter = createWriteFileStreamingReporter({
    hooks: {
      onToolEvent(event) {
        events.push(event)
      },
    },
  })

  reporter.inspect([
    {
      id: 'call-write',
      index: 0,
      function: {
        name: 'write_file',
        arguments: '{"path":"src/a.html","content":"partial',
      },
    },
  ])
  reporter.abortOpen('stream stopped')

  assert.equal(events.length, 2)
  assert.equal(events[0].status, 'running')
  assert.equal(events[1].id, events[0].id)
  assert.equal(events[1].status, 'error')
  assert.equal(events[1].summary, 'stream stopped')
})

test('createWriteFileStreamingReporter emits an early placeholder before arguments stream', () => {
  const events = []
  const reporter = createWriteFileStreamingReporter({
    hooks: {
      onToolEvent(event) {
        events.push(event)
      },
    },
  })

  reporter.inspect([
    {
      id: 'call-write',
      function: {
        name: 'write_file',
        arguments: '',
      },
    },
  ])

  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'write_file')
  assert.equal(events[0].status, 'running')
  assert.equal(events[0].summary, 'Generating write_file content...')
  assert.equal(JSON.parse(events[0].output).contentBytes, 0)
})

test('createWriteFileStreamingReporter ignores other tools', () => {
  const events = []
  const reporter = createWriteFileStreamingReporter({
    hooks: {
      onToolEvent(event) {
        events.push(event)
      },
    },
  })

  reporter.inspect([
    {
      id: 'call-read',
      function: {
        name: 'read_file',
        arguments: '{"path":"src/a.html"}',
      },
    },
  ])

  assert.equal(events.length, 0)
})
