
import { Router } from 'express'
import config from 'config'
import twilio from 'twilio'
import co from 'co'
import r from 'rethinkdb'

import {
  TradeOffers,
  BotItems
} from '../lib/documents'

import {
  TRADE_STATE_DECLINED,

  TRADE_VERIFICATION_STEP_PENDING,
  TRADE_VERIFICATION_STEP_APPROVED,
  TRADE_VERIFICATION_STEP_DENIED
} from '../constant/trade'

import {
  BOT_ITEM_STATE_AVAILABLE
} from '../constant/item'

function onMessage(req, res) {

  function respond(message) {
    const twiml = new twilio.TwimlResponse()
    twiml.message(message)
    res.writeHead(200, {'Content-Type': 'text/xml'})
    res.end(twiml.toString())
  }

  co(function* () {
    const { Body } = req.body
    const split = Body.split(' ')

    if(split.length) {
      const command = split[0].toLowerCase()

      switch(command) {
        case 'yes':
        case 'no':
          // Continue with a pending withdraw
          //

          const securityToken = split[1] || ''
          if(!securityToken) {
            return respond('Invalid security token')
          }

          const offers = yield TradeOffers.filter({
            securityToken,
            verificationState: TRADE_VERIFICATION_STEP_PENDING
          }).coerceTo('array').run(tmp_connection())

          if(!offers.length) {
            return respond('Cannot find trade offer')
          }

          let update

          if(command === 'yes') {
            tmp_redisClient().del(`user:flag:${offers[0].steamId64}`)

            yield TradeOffers.get(offers[0].id).update({
              verificationState: TRADE_VERIFICATION_STEP_APPROVED
            }).run(tmp_connection())

            tmp_amqpCh().publish('skne.withdraw', offers[0].bot, new Buffer(offers[0].id), { persistent: true })
            return respond('Trade verified, sending now.')
          } else {
            tmp_redisClient().set(`user:flag:${offers[0].steamId64}`, true)

            yield TradeOffers
              .get(offers[0].id)
              .update({
                verificationState: TRADE_VERIFICATION_STEP_DENIED,
                state: TRADE_STATE_DECLINED,
                hasError: true,
                error: 'Please try again later'
              }, {
                returnChanges: true
              })
              .run(tmp_connection())
              .then(({ changes }) => {
                if(changes && changes.length) {
                  tmp_amqpCh().sendToQueue('skne.notify', new Buffer(JSON.stringify({
                    server: offers[0].notifyUrl,
                    method: 'trade.OnTradeOfferStateChange',
                    params: changes[0].new_val
                  })))

                  BotItems
                    .getAll(r.args(changes[0].new_val.assetIds), { index: 'assetId' })
                    .update({
                      state: BOT_ITEM_STATE_AVAILABLE
                    })
                    .run(tmp_connection())
                }
              })

            return respond(`Trade was cancelled, steamid ${offers[0].steamId64} has been flagged`)
          }

          return respond('I just do not know what to do')
      }
    }

    respond('[yes/no] [securityToken]')
  })

  .catch(err => {
    logger.error('twilio.onMessage() ' + err)
    respond('Internal error')
  })
}

export default () => {
  const router = Router()

  router.use((req, res, next) => {
    const secret = req.query.secret || ''

    if(config.twilio.secret !== secret) {
      return res.json({ error: 'Invalid secret' })
    }

    next()
  })

  router.post('/message', onMessage)
  return router
}
