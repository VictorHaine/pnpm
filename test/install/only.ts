import path = require('path')
import fs = require('mz/fs')
import tape = require('tape')
import loadJsonFile = require('load-json-file')
import promisifyTape from 'tape-promise'
import {
  prepare,
  testDefaults,
} from '../utils'
import {install} from '../../src'

const basicPackageJson = loadJsonFile.sync(path.join(__dirname, '../utils/simple-package.json'))
const test = promisifyTape(tape)

test('production install (with --production flag)', async (t: tape.Test) => {
  const project = prepare(t, basicPackageJson)

  await install(testDefaults({ development: false }))

  const rimrafDir = fs.statSync(path.resolve('node_modules', 'rimraf'))

  let tapStatErrCode: number = 0
  try {
    fs.statSync(path.resolve('node_modules', '@rstacruz'))
  } catch (err) {
    tapStatErrCode = err.code
  }

  t.ok(rimrafDir.isSymbolicLink, 'rimraf exists')
  t.is(tapStatErrCode, 'ENOENT', 'tap-spec does not exist')
})

test('install dev dependencies only', async (t: tape.Test) => {
  const project = prepare(t, {
    dependencies: {
      once: '^1.4.0',
      'is-positive': '1.0.0',
    },
    devDependencies: {
      inflight: '1.0.6',
    },
  })

  await install(testDefaults({ production: false }))

  const inflight = project.requireModule('inflight')
  t.equal(typeof inflight, 'function', 'dev dependency is available')

  await project.hasNot('once')

  {
    const shr = await project.loadShrinkwrap()
    t.ok(shr.packages['/is-positive/1.0.0'].dev === false)
  }

  {
    const currentShrinkwrap = await project.loadCurrentShrinkwrap()
    t.notOk(currentShrinkwrap.packages['/is-positive/1.0.0'], 'prod dep only not added to current shrinkwrap.yaml')
  }

  // Repeat normal installation adds missing deps to node_modules
  await install(testDefaults())

  await project.has('once')

  {
    const currentShrinkwrap = await project.loadCurrentShrinkwrap()
    t.ok(currentShrinkwrap.packages['/is-positive/1.0.0'], 'prod dep added to current shrinkwrap.yaml')
  }
})