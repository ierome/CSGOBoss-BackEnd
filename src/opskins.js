
import 'babel-polyfill'

import co from 'co'

import { amqpConnect, amqpCh, amqpConnection } from './lib/amqp'
import r from './lib/database'
import redis from './lib/redis'
import logger from './lib/logger'

co(function* () {
  logger.info('Opskins Manager')

  yield amqpConnect()
  amqpCh().prefetch(1)

  // Virtual withdraw exchange
  amqpCh().assertExchange('skne.virtual.withdraw', 'direct', {
    durable: true
  })

  const singleQueue = yield amqpChSingle.assertQueue('skne.opskins', { durable: true })
  yield amqpCh().bindQueue(singleQueue.queue, 'skne.virtual.withdraw', 'opskins')

})

.catch(err => {
  logger.error(`startup error ${err}`)
})
