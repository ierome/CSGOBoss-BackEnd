
import _ from 'underscore'
import fs from 'fs'
import co from 'co'
import path from 'path'

import logger from '../../lib/logger'

const wrapFn = (endpoint, fn) => {
  return function() {
    const done = arguments[arguments.length - 1]
    const args = [].slice.call(arguments, 0, arguments.length - 1)

    co(fn, ...args).then(response => done(null, response), error => {
      logger.error('rpc() error', {
        args,
        endpoint,
        error: error.message || error
      })

      done(error)
    })
  }
}

const modules = _
  .chain(fs.readdirSync(__dirname))
  .filter(file =>
    file.substring(file.length - 3) === '.js' && file !== 'index.js'
  )
  .map(file => {
    const name = file.substring(0, file.length - 3)
    const endpoints = require(path.join(__dirname, file))['default']
    return [name, endpoints]
  })
  .object()
  .value()

const endpoints = _
  .chain(modules)
  .map((endpoints, name) =>
    _.map(endpoints, (fn, endpoint) => {
      const endpointName = `${name}.${endpoint}`
      return [endpointName, wrapFn(endpointName, fn)]
    })
  )
  .reduce((build, endpoints) => Object.assign(build, _.object(endpoints)), {})
  .value()

export function callRPC(method, args) {
  if(typeof endpoints[method] === 'undefined') {
    return Promise.reject('Method not found')
  }

  return new Promise((resolve, reject) =>
    endpoints[method]([ args ], (err, result) => !!err ? reject(err) : resolve(result))
  )
}

export default endpoints
