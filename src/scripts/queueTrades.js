
import 'babel-polyfill'
import co from 'co'

import r from '../lib/database'
import TradeOffers from '../document/offer'
import { amqpConnect, amqpCh, amqpConnection } from '../lib/amqp'
import logger from '../lib/logger'
import { TRADE_STATE_QUEUED, TRADE_TYPE_WITHDRAW, TRADE_VERIFICATION_STEP_PENDING } from '../constant/trade'

co(function* () {
  yield amqpConnect()

  const offers = yield TradeOffers.getAll([ TRADE_TYPE_WITHDRAW, TRADE_STATE_QUEUED ], { index: 'typeState' })

  for(let offer of offers) {
    if(offer.verificationState && offer.verificationState === TRADE_VERIFICATION_STEP_PENDING) {
      continue
    }

    logger.info(`Queueing ${offer.id} (${offer.bot}) for ${offer.steamId64}`)
    amqpCh().publish('skne.withdraw', offer.bot, new Buffer(offer.id), { persistent: true })
  }

  logger.info(`Queued ${offers.length} offers...`)
})

.catch(logger.error)
