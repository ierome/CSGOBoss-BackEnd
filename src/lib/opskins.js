
import config from 'config'
import OPSkinsAPI from '@opskins/api'
import co from 'co'
import { eachSeries } from 'async'
import r from 'rethinkdb'
import _ from 'underscore'

import { TRADE_STATE_CONFIRM, TRADE_STATE_QUEUED, TRADE_TYPE_WITHDRAW } from '../constant/trade'
import { VirtualOffers, BotItems, TradeOffers } from './documents'
import { BOT_ITEM_STATE_AVAILABLE } from '../constant/item'
import { connection } from './database'
import logger from './logger'
import { amqpChannel } from './amqp'

export function fixDelayedOPTrades() {
  logger.info('Checking for delayed opskin trades...')

  const tm = new Date(Date.now() + (60000 * 5))

  return co(function* () {
    const pendingOffers = yield VirtualOffers
      .getAll(TRADE_STATE_CONFIRM, { index: 'state' })
      .filter(r.row('createdAt').le(tm))
      .coerceTo('array')
      .run(connection())

    if(!pendingOffers.length) {
      return
    }

    eachSeries(pendingOffers, (offer, done) => {
      if(!!offer.tradeOfferId) {
        console.log('has offer')
        done()
        return
      }

      const assetIds = offer.assetIds || []
      const itemNames = offer.itemNames || []
      const botItemIds = offer.botItemIds || []

      let readyToSend = (assetIds.length === itemNames.length)

      co(function* () {
        const availableBotItems = yield BotItems
          .getAll(BOT_ITEM_STATE_AVAILABLE, { index: 'state' })
          .filter(r.row('createdAt').ge(offer.createdAt).and(r.row('opskins').default(false).eq(false)))
          .coerceTo('array')
          .run(connection())

        const botItems = yield BotItems
          .getAll(r.args(botItemIds))
          .orderBy(r.asc('createdAt'))
          .coerceTo('array')
          .run(connection())

        const itemsMissing = itemNames

        botItems.forEach(botItem => {
          const idx = itemsMissing.indexOf(botItem.name)
          if(idx >= 0) {
            itemsMissing.splice(idx, 1)
          }
        })

        const foundItems = []

        itemsMissing.forEach(name => {
          const botItem = _.findWhere(availableBotItems, {
            name
          })

          if(botItem) {
            foundItems.push(botItem)
          }
        })

        if(foundItems.length > 0) {
          logger.info(`Found ${foundItems.length} missing item(s) for opskins offer ${offer.id}`)

          let { changes } = yield BotItems
            .getAll(r.args(_.pluck(foundItems, 'id')))
            .update({
              opskins: true
            }, { returnChanges: true })
            .run(connection())

          const newBotItemsIds = _.pluck(_.pluck(changes, 'new_val'), 'id')
          const newBotItemsAssetIds = _.pluck(_.pluck(changes, 'new_val'), 'assetId')

          const botItemsIdsRow = r.row('botItemIds').default([])
          const newBotItemsIdRow = botItemsIdsRow.add(newBotItemsIds)

          const updateResult = yield VirtualOffers
            .getAll(offer.id)
            .update({
              botItemIds: newBotItemsIdRow,
              assetIds: r.row('assetIds').default([]).add(newBotItemsAssetIds)
            }, {
              returnChanges: true
            })
            .run(connection())

          if(updateResult.replaced > 0) {
            offer = updateResult.changes[0].new_val
            if(offer.assetIds.length === offer.itemNames.length) {
              readyToSend = true
            }
          }
        }

        if(readyToSend) {
          const botItem = yield BotItems.get(offer.botItemIds[0]).run(connection())

          const newTradeOffer = {
            createdAt: new Date(),
            type: TRADE_TYPE_WITHDRAW,
            state: TRADE_STATE_QUEUED,
            steamId64: offer.steamId,
            tradeLink: offer.tradeUrl,
            notifyUrl: offer.notifyUrl,
            assetIds: offer.assetIds,
            subtotal: offer.subtotal,
            itemNames: offer.itemNames,
            bot: botItem.bot,

            meta: {
              ...offer.meta,
              virtualOfferId: offer.id
            }
          }

          const { generated_keys: [ newTradeOfferId ] } = yield TradeOffers.insert(newTradeOffer, { returnChanges: true }).run(connection())
          newTradeOffer.id = newTradeOfferId

          yield VirtualOffers.get(offer.id).update({
            tradeOfferId: newTradeOfferId
          }).run(connection())

          amqpChannel().publish('skne.withdraw', newTradeOffer.bot, new Buffer(newTradeOfferId), { persistent: true })
        }

        done()
      })

      .catch(err => {

        if(!!err) {
          logger.error(`fixDelayedOPTrades() ${err}`)
        }

        done()
      })

    })
  })
}

const clients =  config.opskins.apiKeys.map(c => {
  const client = new OPSkinsAPI(c.key)
  client._steamId = c.steamId
  return client
})

export function pollOPInventory() {
  setInterval(() => {
    clients.forEach(client => {
      client.getInventory((err, data) => {
        if(!!err) {
          logger.error(`pollOpskins() ${err}`)
          return
        }

        const withdrawable = data.items.filter(i => !i.requires_support && !i.can_repair && !i.offer_id).map(i => i.id)
        const needsRepair = data.items.filter(i => !i.requires_support && i.can_repair && !i.offer_id).map(i => i.id)

        if(withdrawable.length > 0) {
          client.withdrawInventoryItems(withdrawable, (err) => {
            if(err) {
              logger.error(`pollOpskins() withdraw ${err}`)
            }
          })
        }
      })
    })

  }, 15000)
}

export default clients
