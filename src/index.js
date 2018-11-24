
import 'babel-polyfill'

import rpc from 'node-json-rpc'
import r from 'rethinkdb'
import redis from 'redis'
import url from 'url'
import querystring from 'querystring'
import bluebird from 'bluebird'
import co from 'co'
import amqplib from 'amqplib'
import config from 'config'
import { eachSeries, mapSeries, filterSeries } from 'async'
import randomstring from 'randomstring'
import TradeOfferManager from 'steam-tradeoffer-manager'
import _ from 'underscore'
import twilio from 'twilio'
import numeral from 'numeral'
import express from 'express'
import jayson from 'jayson'
import bodyParser from 'body-parser'
import SteamID from 'steamid'
import requestIp from 'request-ip'

import {
  TRADE_TYPE_DEPOSIT,
  TRADE_TYPE_INCOMING,
  TRADE_STATE_QUEUED,
  TRADE_STATE_SENT,
  TRADE_TYPE_WITHDRAW,
  TRADE_STATE_ERROR,
  TRADE_STATE_CONFIRM,
  TRADE_STATE_ESCROW,
  TRADE_VERIFICATION_STEP_PENDING,
  TRADE_STATE_PENDING
} from './constant/trade'

import {
  BOT_ITEM_STATE_AVAILABLE,
  BOT_ITEM_STATE_IN_USE
} from './constant/item'

import {
  VirtualOffers,
  TradeOffers,
  Bots,
  Items,
  BotItems,
  migrateDocuments
} from './lib/documents'

import logger from './lib/logger'
import { canAcceptItem } from './lib/bot'
import api from './api'
import * as bitskins from './lib/bitskins'
import opskins, { fixDelayedOPTrades, pollOPInventory } from './lib/opskins'
import * as database from './lib/database'
import { callAmqpRpcCb } from './lib/amqp'

import rpcApi, { callRPC } from './api/rpc'

// P R O M I S E S = ^ )
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

const tradeOfferManager = new TradeOfferManager()
const twilioClient      = (!!config.twilio ? twilio(config.twilio.sid, config.twilio.token) : null)
const app               = express()

const redisClient       = redis.createClient(config.redis)
// bad practice, this is temp.
global.tmp_redisClient = () => redisClient

let connection
// bad practice, this is temp.
global.tmp_connection = () => connection

let amqpCh
let amqpChSingle

// bad practice, this is temp.
global.tmp_amqpCh = () => amqpCh

const rpcServer = jayson.server({
  ...rpcApi,

  'inventory.fetch': getInventory,
  'inventory.deposit': deposit,
  'inventory.withdraw': withdraw,
  'inventory.store': storeItems,
  'inventory.clearCache': clearInventoryCache,
  // 'inventory.restock': restockItems,

  'items.botItems': getBotItems,
  'items.value': getBotItemsValue,
  'items.search': searchItems,
  'items.getAll': itemsGetAll,
  'items.update': itemsUpdate,

  'offers.cancel': cancelTradeOffer,
  'offers.confirm': confirmTradeOffer,
  'offers.fetch': getOffers,
  'offer.fetch': getOffer,
  'offer.requeue': requeueOffer,

  'trade.offers': getTradeOffers,
  'trade.refund': refund,

  'bot.info': getBotInfo,
  'bot.storage': getStorageBots,
  'bot.getAll': getBots,
}, {
  version: 1
})

function itemsUpdate([ update ], done) {
  if(!update || !update.id) {
    return done('Invalid update request')
  }

  co(function* () {
    const { id, ...attributes } = update

    yield Items.get(id).update(attributes).run(connection)
    done(null, {
      success: true
    })
  })

  .catch(err => {
    logger.error(`itemsUpdate() ${err}`)
    done(err.message)
  })
}

// function restockItems([{ itemName, amount }], done) {
//   co(function* () {
//
//     const item = yield Items.getAll(itemName, { index: 'name' }).coerceTo('array').run(connection)
//     if(!item.length) {
//       return done('Cannot find item')
//     } else if(amount > 80) {
//       return done('Max items you can purchase is 80')
//     }
//
//     const items = yield new Promise((resolve, reject) => {
//       opskins.search({
//         app: '730_2',
//         search_item: `"${itemName}"`,
//         max: item[0].basePrice
//       }, (err, items) => {
//         if(err) {
//           return reject(err.message)
//         }
//
//         resolve(items.filter(i => i.amount <= item[0].basePrice*100 && i.market_name === itemName))
//       })
//     })
//
//     if(items.length <= 0) {
//       return done('Cannot find items on sale to purchase')
//     } else if(items.length < amount) {
//       return done(`There are only ${items.length} available to purchase`)
//     }
//
//     const itemsToPurchase = items.slice(0, amount)
//     const buyResponse = yield new Promise((resolve, reject) => {
//       opskins.buyItems(_.pluck(itemsToPurchase, 'id'), itemsToPurchase.reduce((t, i) => t + i.amount, 0), (err, response) => {
//         if(err) {
//           return reject(err.message)
//         }
//
//         resolve(response)
//       })
//     })
//
//     yield new Promise((resolve, reject) => {
//
//       let attempts = 0
//
//       function retry() {
//         opskins.withdrawInventoryItems(_.pluck(buyResponse, 'new_itemid'), (err, response) => {
//           if(err) {
//
//             if(attempts <= 5) {
//               attempts++
//               setTimeout(retry, 3000)
//             } else {
//               return reject(err.message)
//             }
//           }
//
//           resolve(response)
//         })
//       }
//
//
//       retry()
//     })
//
//     done()
//   })
//
//   .catch(err => {
//     logger.error(`restockItems() ${err}`)
//     done(err)
//   })
// }

function itemsGetAll([{ itemNames, options }], done) {
  co(function* () {
    let query = Items
      .getAll(r.args(itemNames), {
        index: !!options.byCleanName && options.byCleanName ? 'cleanName' : 'name'
      })

    if(options.includeBotItemCount) {
      query = query.map(item =>
        item.merge({
          botItemCount: BotItems.getAll(item('name'), { index: 'name' }).filter({ state: BOT_ITEM_STATE_AVAILABLE }).count()
        })
      )
    }

    const items = yield query.coerceTo('array').run(connection)
    done(null, items)
  })

  .catch(err => {
    logger.error(`itemsGetAll() ${err}`)
    done(err)
  })
}

function searchItems([{ query, hasCustomPrice }], done) {
  co(function* () {
    let q = !!query && query.indexOf('(') >= 0 ?
      Items.getAll(query, { index: 'name' }) : Items

    let filter = null

    if(hasCustomPrice) {
      const customPriceFilter = r.row.hasFields('customPrice').and(r.row('customPrice').gt(0))
      filter = !!filter ? filter.add(customPriceFilter) : customPriceFilter
    }

    if(!!query) {
      const queryFilter = r.row('name').match(query)
      filter = !!filter ? filter.add(queryFilter) : queryFilter
    }

    if(!!filter) {
      q = q.filter(filter)
    }

    const items = yield q
      .limit(50)
      .coerceTo('array')
      .run(connection)

    done(null, items)
  })

  .catch(err => {
    logger.error(`searchItems() ${err}`)
    done(err.message)
  })
}

// RPC bot.info
function getBotInfo([{ steamId64 }], done) {
  co(function* () {
    const bots = yield Bots
      .getAll(steamId64, { index: 'steamId64' })
      .coerceTo('array')
      .run(connection)

    if(!bots.length) {
      return done('Could not find bot')
    }

    done(null, bots[0])
  })
}

// RPC trade.offers
function getTradeOffers([{ steamId64 }], done) {
  co(function* () {
    const offers = yield TradeOffers
      .getAll([ TRADE_TYPE_INCOMING, TRADE_STATE_SENT ], { index: 'typeState' })
      .filter({ steamId64 })
      .coerceTo('array')
      .run(connection)

    done(null, offers)
  })

  .catch(done)
}

// RPC inventory.clearCache
function clearInventoryCache([{ steamId64 }], done) {
  redisClient.del(`inventory:${steamId64}`)
  done()
}

// RPC inventory.fetch
function getInventory([{ steamId64, refresh, details, discount, tradeUrl, blacklistedItems }], done) {
  discount = discount || 0
  blacklistedItems = (blacklistedItems || []).map(item => item.trim())

  co(function* () {
    if(!!tradeUrl) {
      const u = url.parse(tradeUrl)
      const qs = querystring.parse(u.query)

      if(!!qs.partner) {
        steamId64 = SteamID.fromIndividualAccountID(parseInt(qs.partner)).getSteamID64()
      }
    }

    const cacheKey = `inventory:${steamId64}:${discount}`
    if(!refresh) {
      // Check if this inventory has been cached first
      const cached = yield redisClient.getAsync(cacheKey)

      if(cached) {
        return done(null, JSON.parse(cached))
      }
    }

    tradeOfferManager.getUserInventoryContents(steamId64, 730, 2, true, (err, inventory) => {
      if(err) {
        return done(err)
      }

      inventory = inventory.filter(item => blacklistedItems.indexOf(item.market_hash_name) < 0)

      co(function* () {
        const items = yield Items
          .getAll(r.args(inventory.map(item => item.market_hash_name)), { index: 'name' })
          .coerceTo('array')
          .run(connection)

        const validItems = inventory
          .map(({ market_hash_name, assetid, type }) => {
            const item = items.filter(item => item.name === market_hash_name)
            if(!item.length) {
              return null
            }

            return {
              ...item[0],
              assetId: parseInt(assetid),
              type
            }
          })

          .filter(item => !!item && canAcceptItem(item))

          .map(item => {
            let price = item.price

            if(discount > 0) {
              price = item.price * discount
              item.tokens = parseInt(item.baseTokens * discount)
            }

            return {
              ...item,
              price,
            }
          })

        let response
        if(details) {
          response = {
            items: validItems,
            cannotAccept: inventory.length - validItems.length
          }
        } else {
          response = validItems
        }

        // Cache inventory
        redisClient.set(cacheKey, JSON.stringify(response))
        redisClient.expire(cacheKey, 600)

        redisClient.set(`inventoryItems:${steamId64}:${discount}`, JSON.stringify(validItems))
        redisClient.expire(`inventoryItems:${steamId64}:${discount}`, 600)

        done(null, response)
      })

      .catch(err => done(err))
    })
  })

  .catch(done)
}

// RPC inventory.deposit
function deposit([{ notifyUrl, steamId64, tradeLink, assetIds, meta, discount, depositGroup, includeItems, forceLockItems }], done) {
  if(!notifyUrl) {
    return done('missing notify url')
  } else if(!assetIds.length ){
    return done(null, { error: 'Invalid items' })
  } else if(!tradeLink) {
    return done(null, { error: 'Invalid trade link' })
  }

  discount = discount || 0

  co(function* () {
    meta = {
      ...(meta || {}),
      steamId64
    }

    if(!!tradeLink) {
      const u = url.parse(tradeLink)
      const qs = querystring.parse(u.query)

      if(!!qs.partner) {
        steamId64 = SteamID.fromIndividualAccountID(parseInt(qs.partner)).getSteamID64()
      }
    }

    // Check if this inventory has been cached first
    const cached = yield redisClient.getAsync(`inventoryItems:${steamId64}:${discount}`)

    if(!cached) {
      return done(null, {
        error: 'Session expired, refresh inventory first'
      })
    }

    if(assetIds.length > config.maxDepositItems) {
      return done(null, { error: `Max deposit size is ${config.maxDepositItems} items`})
    }

    const cachedItems = JSON.parse(cached)
    const items       = cachedItems.filter(item => assetIds.indexOf(item.assetId) >= 0)
    const subtotal    = items.reduce((t, i) => t + i.tokens, 0)
    const baseSubtotal        = items.reduce((t, i) => t + (i.baseTokens || 0), 0)
    const baseSubtotalPrice   = items.reduce((t, i) => t + (i.basePrice || 0), 0)

    const subtotalPrice = Math.round(items.reduce((t, i) => t + i.price, 0) * 100) / 100

    const tradeOffer = {
      steamId64,
      tradeLink,
      notifyUrl,
      assetIds,
      subtotal,
      baseSubtotal,
      baseSubtotalPrice,
      subtotalPrice,
      meta,

      createdAt: new Date(),
      securityToken: randomstring.generate(5).toUpperCase(),
      type: TRADE_TYPE_DEPOSIT,
      state: TRADE_STATE_QUEUED,
      itemNames: items.map(i => i.name)
    }

    if(forceLockItems) {
      tradeOffer.forceLockItems = forceLockItems
    }

    if(includeItems) {
      tradeOffer.items = _.map(items, i => _.pick(i, 'name', 'assetId', 'nameColor', 'tokens', 'basePrice', 'price', 'wear', 'icon', 'cleanName'))
    }

    let queueName = 'skne.deposit'

    if(!!depositGroup) {
      queueName += '.' + depositGroup
      tradeOffer.depositGroup = depositGroup
    }

    const { generated_keys } = yield TradeOffers.insert(tradeOffer).run(connection)

    amqpCh.sendToQueue(queueName, new Buffer(generated_keys[0]), { persistent: true })

    done(null, {
      tradeOffer: {
        id: generated_keys[0],
        state: tradeOffer.state,
        securityToken: tradeOffer.securityToken
      }
    })
  })

  .catch(err => done(err))
}

// RPC inventory.refund
function refund([{ tradeOfferId, meta }], done) {
  logger.info(`Refunding trade offer ${tradeOfferId}`)

  co(function* () {
    const offer = yield TradeOffers.get(tradeOfferId).run(connection)
    if(!offer) {
      return done()
    }

    meta = meta || {}
    meta.refundedOffer = tradeOfferId

    const assetIds = offer.assetIds

    BotItems
      .getAll(r.args(assetIds), { index: 'assetId' })
      .update({
        state: BOT_ITEM_STATE_AVAILABLE
      })
      .run(connection)

    const params = {
      assetIds,
      meta,
      tradeLink: offer.tradeLink,
      notifyUrl: offer.notifyUrl,
      steamId64: offer.steamId64
    }

    if(!!offer.depositGroup) {
      params.withdrawGroup = offer.depositGroup
    }

    withdraw([params], done)
  })

  .catch(logger.error)
}

// RPC inventory.withdraw
export function withdraw([{ ignoreBusy, notifyUrl, steamId64, tradeLink, assetIds, meta, itemNames, withdrawGroup, ignoreSecurity }], done) {
  co(function* () {
    let unavailableItemNames = !!itemNames ? [...itemNames] : []

    const disabled = yield redisClient.getAsync(`skne:disable:withdraw`)
    if(disabled) {
      return done('Withdraw is disabled')
    }

    if(itemNames && itemNames.length && !assetIds) {
      assetIds = []

      const grouped = yield BotItems
        .getAll(r.args(_.uniq(itemNames).map(item => [ item, BOT_ITEM_STATE_AVAILABLE ])), { index: 'nameState' })
        .group('name')
        .coerceTo('array')
        .run(connection)

      const available = _
        .chain(grouped)
        .map(group => [group.group, group.reduction])
        .object()
        .value()

        for(let item of itemNames) {
          if(!available[item] || !available[item].length) {
            continue
          }

          const idx = unavailableItemNames.indexOf(item)
          unavailableItemNames.splice(idx, 1)

          const take = available[item].splice(0, 1)[0]
          assetIds.push(take.assetId)

          if(!available[item].length) {
            delete available[item]
          }
        }
    }

    if(!assetIds || !assetIds.length) {
      return done(null, {
        unavailableItemNames,
        error: 'Invalid items'
      })
    }

    if(!ignoreSecurity) {
      const flagged = yield redisClient.getAsync(`user:flag:${steamId64}`)
      if(flagged) {
        return done('User is flagged')
      }
    }

    const botItems = yield BotItems
      .getAll(r.args(assetIds), { index: 'assetId' })
      .eqJoin('name', Items, { index: 'name' })
      .zip()
      .coerceTo('array')
      .run(connection)

    const result = yield BotItems
      .getAll(r.args(ignoreBusy ? assetIds : assetIds.map(id => ([id, BOT_ITEM_STATE_AVAILABLE]))), { index: ignoreBusy ? 'assetId' : 'assetIdState' })
      .update(item =>
        r.branch(ignoreBusy ? true : item('state').eq(BOT_ITEM_STATE_AVAILABLE), {
          state: BOT_ITEM_STATE_IN_USE,
          owner: steamId64
        }, {})
      , { returnChanges: true })
      .run(connection)

    const unavailable = !ignoreBusy && result.replaced > 0 ? assetIds.filter(id => {
      for(let change of result.changes) {
        if(change.new_val.assetId === id) {

          const idx = unavailableItemNames.indexOf(change.new_val.name)
          if(idx >= 0) {
            itemNames.splice(idx, 1)
          }

          return false
        }
      }

      return true
    }) : assetIds

    const botOfferItems = {}

    m: for(let assetId of assetIds) {
      for(let botItem of botItems) {
        if(botItem.assetId === assetId) {
          if(typeof botOfferItems[botItem.bot] === 'undefined') {
            botOfferItems[botItem.bot] = []
          }

          botOfferItems[botItem.bot].push(botItem)
          continue m
        }
      }
    }

    const botOffers = []

    for(let bot in botOfferItems) {
      const assetIds  = botOfferItems[bot].map(b => b.assetId)
      const itemNames = botOfferItems[bot].map(b => b.name)
      const subtotal  = botOfferItems[bot].reduce((t, i) => t + i.tokens, 0)
      const price  = botOfferItems[bot].reduce((t, i) => t + i.price, 0)

      const tradeOffer = {
        steamId64,
        tradeLink,
        notifyUrl,
        assetIds,
        subtotal,
        itemNames,
        bot,

        securityToken: randomstring.generate({ length: 6, charset: 'numeric' }),

        createdAt: new Date(),
        meta: meta || {},
        type: TRADE_TYPE_WITHDRAW,
        state: TRADE_STATE_QUEUED,

        botName: Bots.getAll(bot, { index: 'steamId64' }).nth(0)('name').coerceTo('string')
      }

      if(!!withdrawGroup) {
        tradeOffer.withdrawGroup = withdrawGroup
      }

      const { changes, generated_keys } = yield TradeOffers.insert(tradeOffer, { returnChanges: true }).run(connection)
      tradeOffer.id = generated_keys[0]

      // SECURITY: Verify sending trades
      if(!ignoreSecurity && config.security.verifyTrades) {
        if(tradeOffer.subtotal >= config.security.verifyTradeMinimum) {
          logger.info(`${steamId64}'s withdraw for $${numeral(price).format('0,0.00')} needs verification`)
          redisClient.set(`user:flag:${steamId64}`, true)

          yield TradeOffers.get(tradeOffer.id).update({
            verificationState: TRADE_VERIFICATION_STEP_PENDING
          }).run(connection)

          for(let method in config.security.verificationMethods) {
            const settings = config.security.verificationMethods[method]

            if(method === 'twilio') {
              settings.notify.forEach(number => {
                twilioClient
                  .messages
                  .create({
                    to: number,
                    from: settings.from,
                    body: `CONFIRM: ${steamId64}'s withdraw for $${numeral(price).format('0,0.00')} needs verification. "YES/NO ${tradeOffer.securityToken}"?`
                  })

                  .catch(err => {
                    logger.error(`withdraw() verification: cannot send twilio message: ${err}`)
                  })
                })
            }
          }

          // return resolve()
        } else {
          amqpCh.publish('skne.withdraw', bot, new Buffer(generated_keys[0]), { persistent: true })
        }
      } else {
        amqpCh.publish('skne.withdraw', bot, new Buffer(generated_keys[0]), { persistent: true })
      }

      botOffers.push(changes[0].new_val)
    }

    done(null, {
      unavailable,
      unavailableItemNames,
      tradeOffers: botOffers
    })
  })

  .catch(err => {
    logger.error(`withdraw() ${err}`)
    done(err)
  })
}

// onNotification
function onNotification(msg) {
  const action = JSON.parse(msg.content.toString())
  if(!action.server) {
    amqpCh.ack(msg)
    return
  }

  const u = url.parse(action.server)
  const client = jayson.client[u.protocol.substring(0, u.protocol.length - 1)]({
    host: u.hostname,
    port: u.port,
    path: u.path
  })

  client.request(action.method, action.params || [], (err, response) => {
    if(err || !!response.error) {
      const errorMessage = !!response ? response.error : err
      logger.error(`onNotification ${errorMessage}`, {
        errorMessage,
        server: action.server,
        method: action.method
      })

      return setTimeout(() => amqpCh.nack(msg), 500)
    }

    amqpCh.ack(msg)
  })
}

// RPC items.botItems
function getBotItems([{ page, perPage, search, order }], done) {
  page    = page || 1
  perPage = perPage || 30
  search  = search || ''

  let asc = order === 'ASC'

  co(function* () {
    let query = BotItems
      .getAll(BOT_ITEM_STATE_AVAILABLE, { index: 'state' })

    if(search.length) {
      query = query.filter(r.row('name').match(`(?i)${search}`))
    }

    const totalItems = yield query.count().run(connection)
    const pages = Math.ceil(totalItems / perPage)

    if(page > pages) {
      page = pages
    } else if(page <= 0) {
      page = 1
    }


    const start = (page - 1) * perPage
    const items = yield query
      .eqJoin('name', Items, { index: 'name' })
      .zip()
      .map(item =>
        item.merge({
          basePrice: r.branch(item('customPrice').default(0).gt(0), item('customPrice'), item('basePrice')),
          baseTokens: r.branch(item('customPrice').default(0).gt(0), item('customPrice').mul(config.tokenMultiplier), item('baseTokens')),

          price: r.branch(item('customPrice').default(0).gt(0), item('customPrice').mul(config.prices.markup), item('price')),
          tokens: r.branch(item('customPrice').default(0).gt(0), item('customPrice').mul(config.prices.markup).mul(config.tokenMultiplier), item('tokens'))
        })
      )
      .orderBy(asc ? r.asc('tokens') : r.desc('tokens'))
      .slice(start, start + perPage)
      .run(connection)

    done(null, {
      totalItems,
      pages,
      page,
      items
    })
  })

  .catch(err => logger.error(err))
}

// RPC items.value
function getBotItemsValue([{ assetIds, format }], done) {
  format = format || 'tokens'

  co(function* () {
    const total = yield BotItems
      .getAll(r.args(assetIds), { index: 'assetId' })
      .eqJoin('name', Items, { index: 'name' })
      .zip()
      .sum(format === 'usd' ? 'price' : 'tokens')
      .run(connection)

    console.assert(total > 0, 'total is greater than 0')
    done(null, total)
  })

  .catch(logger.error)
}

// RPC offers.cancel
function cancelTradeOffer([{ id, steamId64 }], done) {
  co(function* () {
    const tradeOffers = yield TradeOffers
      .getAll(id)
      .filter({ steamId64 })
      .coerceTo('array')
      .run(connection)

    if(!tradeOffers.length) {
      return done('offer not found')
    }

    amqpCh.publish('skne.control', tradeOffers[0].bot, new Buffer(JSON.stringify({
      offerId: tradeOffers[0].offerId,
      action: 'cancelOffer'
    })))

    done(null, { success: true })
  })

  .catch(done)
}

// RPC offers.confirm
function confirmTradeOffer([{ id, steamId64 }], done) {
  co(function* () {
    const tradeOffers = yield TradeOffers
      .getAll(id)
      .filter({ steamId64 })
      .coerceTo('array')
      .run(connection)

    if(!tradeOffers.length) {
      return done('offer not found')
    }

    amqpCh.publish('skne.control', tradeOffers[0].bot, new Buffer(JSON.stringify({
      offerId: tradeOffers[0].offerId,
      action: 'confirmOffer'
    })))

    done(null, { success: true })
  })

  .catch(done)
}

// RPC bot.getAll
function getBots(params, done) {
  co(function* () {
    const bots = yield Bots
      .getAll(r.args(_.uniq(_.map(config.bots, bot => bot.username))), { index: 'username' })
      .map(bot =>
        bot.merge({
          itemCount: BotItems.getAll(bot('steamId64'), { index: 'bot' }).count(),
          estimatedValue: BotItems
            .getAll(bot('steamId64'), { index: 'bot' })
            .eqJoin('name', Items, { index: 'name' })
            .zip()
            .sum('price')
        })
      )
      .coerceTo('array')
      .run(connection)

    done(null, bots)
  })

  .catch(logger.error)
}

// RPC bot.storage
function getStorageBots(params, done) {
  co(function* () {
    const bots = yield Bots
      .getAll(r.args(_.map(config.bots, bot => bot.username)), { index: 'username' })
      .filter({ storage: true })
      .map(bot =>
        bot.merge({
          itemCount: BotItems.getAll(bot('steamId64'), { index: 'bot' }).count(),
          estimatedValue: BotItems
            .getAll(bot('steamId64'), { index: 'bot' })
            .eqJoin('name', Items, { index: 'name' })
            .zip()
            .sum('price')
        })
      )
      .coerceTo('array')
      .run(connection)

    done(null, bots)
  })

  .catch(logger.error)
}

// RPC inventory.store
function storeItems([{ items, notifyUrl }], done) {
  co(function* () {
    const botItems = yield BotItems
      .getAll(r.args(items), { index: 'assetId' })
      .coerceTo('array').run(connection)
    if(!botItems.length) {
      return done()
    }

    const groups = _.groupBy(botItems, 'bot')
    const bots   = yield Bots
      .filter({ storage: true })
      .map(bot =>
        bot.merge({
          items: BotItems.getAll(bot('steamId64'), { index: 'bot' }).count()
        })
      )
      .filter(r.row('items').lt(950).and(r.row('tradeLink').default(null).ne(null)))
      .coerceTo('array')
      .run(connection)

    if(!bots.length) {
      logger.info('storeItems() tried to store items but no bots available')
      return done(null, { unavailable: true })
    }

    bots.sort((a, b) => a.items - b.items)

    for(let group in groups) {
      const params = {
        notifyUrl,

        steamId64: bots[0].steamId64,
        tradeLink: bots[0].tradeLink,
        assetIds: groups[group].map(item => item.assetId)
      }

      withdraw([params], function(err) {
      })
    }
  })

  .catch(logger.error)
}

// RPC offers.fetch
function getOffers([{ limit, steamId64 }], done) {
  co(function* () {
    let q = TradeOffers

    if(!!steamId64) {
      q = q.getAll(steamId64, { index: 'steamId64' })
    }

    if(!!limit) {
      q = q.limit(limit)
    }

    const offers = yield q.orderBy(r.desc('createdAt')).coerceTo('array').run(connection)
    done(null, offers)
  })

  .catch(logger.error)
}

// RPC offer.fetch
function getOffer([{ id }], done) {
  co(function* () {
    const offer = yield TradeOffers.get(id).run(connection)
    done(null, offer)
  })

  .catch(logger.error)
}

// RPC offer.requeue
function requeueOffer([{ id }], done) {
  co(function* () {
    const offer = yield TradeOffers.get(id).run(connection)
    if(!offer) {
      return done('Cannot find trade offer')
    }

    amqpCh.publish('skne.withdraw', offer.bot, new Buffer(offer.id), { persistent: true })
    done()
  })

  .catch(logger.error)
}

function publishNotification(params) {
  const servers = _.values(config.servers)

  if(!!params.notifyUrl) {
    servers.push(params.notifyUrl)
  }

  _.uniq(servers).forEach(server => {
    amqpChSingle.sendToQueue('skne.notify', new Buffer(JSON.stringify({
      server,
      params,
      method: 'offer.change'
    })))
  })
}

function onMessage(message) {
  if (!!message.properties.correlationId) {
    callAmqpRpcCb(message.properties.correlationId, message)
  }

  switch(message.fields.exchange) {
    case 'skne.virtual.withdraw':
      onVirtualOffer(message)
      break

    default:
      amqpChSingle.ack(message)
      break
  }
}

function onVirtualOffer(message) {
  const id = message.content.toString()

  co(function* () {
    const offer = yield VirtualOffers.get(id).run(tmp_connection())
    if(!offer) {
      return amqpChSingle.nack(message, false, false)
    }

    if(offer.state === TRADE_STATE_QUEUED) {
      try {
        let purchaseResponse = yield callRPC('opskins.purchase', {
          itemNames: offer.itemNames,
          maxPrice: offer.subtotal
        })

        const { replaced, changes } = yield VirtualOffers
          .get(id)
          .update({
            purchaseResponse,
            hasPurchaseResponse: true,

            state: TRADE_STATE_ESCROW,
            escrowAt: new Date(),
            itemNames: purchaseResponse.itemNames,
            items: purchaseResponse.items,
            itemIds: _.pluck(purchaseResponse.items, 'id')
          }, {
            returnChanges: true
          })
          .run(tmp_connection())

        if(replaced > 0) {
          publishNotification(changes[0].new_val)
        }

        amqpChSingle.publish('skne.virtual.withdraw', offer.provider, new Buffer(offer.id), {
          persistent: true
        })

        amqpChSingle.ack(message)
      } catch(error) {
        const errorMessage = error.message || error
        logger.error('onVirtualOffer() queued', {
          offerId: id,
          errorMessage
        })

        const { replaced, changes } = yield VirtualOffers.get(id).update({
          errorMessage,
          itemNames: error.itemNames || offer.itemNames,
          hasError: true,
          retry: errorMessage.indexOf('Bad Gateway') >= 0,
          error: error.stack || error,
          state: TRADE_STATE_ERROR,
          previousState: r.branch(r.row.hasFields('previousState'), r.row('previousState'), r.row('state')),
          errorAt: new Date()
        }, { returnChanges: true }).run(tmp_connection())

        if(replaced > 0) {
          publishNotification(changes[0].new_val)
        }

        amqpChSingle.nack(message, false, false)
      }
    } else if(offer.state === TRADE_STATE_ESCROW) {
      // Withdraw the item to the bot
      //

      try {
        yield callRPC('opskins.withdraw', {
          itemIds: offer.itemIds
        })
      } catch(error) {
        const errorMessage = error.message || error
        logger.error('onVirtualOffer() escrow', {
          errorMessage,
          offerId: id
        })
      }

      const { replaced, changes } = yield VirtualOffers
        .get(id)
        .update({
          state: TRADE_STATE_PENDING,
          sentAt: new Date()
        }, {
          returnChanges: true
        })
        .run(tmp_connection())

      if(replaced > 0) {
        publishNotification(changes[0].new_val)
      }

      amqpChSingle.ack(message)
    } else {
      amqpChSingle.nack(message, false, false)
    }
  })

  .catch(error => {
    const errorMessage = error.message || error
    logger.error('onVirtualOffer()', {
      offerId: id,
      error: error.stack || error,
      errorMessage
    })

    VirtualOffers
      .get(id)
      .update({
        errorMessage,
        hasError: true,
        error: error.stack || error,
        state: TRADE_STATE_ERROR,
        previousState: r.branch(r.row.hasFields('previousState'), r.row('previousState'), r.row('state')),
        errorAt: new Date()
      }, {
        returnChanges: true
      })
      .run(tmp_connection())
      .then(response => {

        if(response.replaced > 0) {
          publishNotification(response.changes[0].new_val)
        }

        amqpChSingle.nack(message, false, false)
      }, error => {
        logger.error('onVirtualOffer()', {
          offerId: id,
          error: error.stack || error
        })

        amqpChSingle.nack(message, false, false)
      })
  })
}

function pollPendingOffers() {
  co(function* () {
    const pendingOffers = yield VirtualOffers
      .getAll(TRADE_STATE_PENDING, { index: 'state' })
      .coerceTo('array')
      .run(database.connection())

    if(!pendingOffers.length) {
      setTimeout(() => pollPendingOffers(), 5000)
      return
    }

    eachSeries(pendingOffers, (offer, done) => {
      co(function* () {
        const unavailable = offer.itemNames.slice(0)
        const found = []

        const grouped = yield BotItems
          .getAll(r.args(_.uniq(offer.itemNames).map(item => [ item, BOT_ITEM_STATE_AVAILABLE ])), { index: 'nameState' })
          .filter({ bot: offer.opBot })
          .group('name')
          .coerceTo('array')
          .run(database.connection())

        const available = _
          .chain(grouped)
          .map(group => [group.group, _.uniq([ group.reduction[0], ...group.reduction ], false, i => i.assetId)])
          .object()
          .value()

        for(let item of offer.itemNames) {
          if(!available[item] || !available[item].length) {
            continue
          }

          let idx = unavailable.indexOf(item)
          unavailable.splice(idx, 1)

          let take = available[item].splice(0, 1)[0]

          found.push({
            id: take.id,
            assetId: take.assetId
          })

          if(!available[item].length) {
            delete available[item]
          }
        }

        if(unavailable.length > 0) {
          done()
          return
        }

        const assetIds = _.pluck(found, 'assetId')
        const uniqueAssetIds = _.uniq(assetIds)

        if(uniqueAssetIds.length !== found.length) {
          logger.error(`pollPendingOffers() ${offer.id} had duplicate asset ids: ${assetIds.join(',')}`)
          done()
          return
        }

        const result = yield BotItems
          .getAll(r.args(found.map(i => ([i.id, BOT_ITEM_STATE_AVAILABLE]))), { index: 'idState' })
          .update(item =>
            r.branch(item('state').eq(BOT_ITEM_STATE_AVAILABLE), {
              state: BOT_ITEM_STATE_IN_USE,
              owner: offer.steamId
            }, {})
          , { returnChanges: true })
          .run(database.connection())

        if(result.replaced !== found.length) {
          const ids = _.pluck(_.pluck(result.changes, 'new_val'), 'id')

          yield BotItems.getAll(r.args(ids)).update({
            state: BOT_ITEM_STATE_AVAILABLE
          }).run(database.connection())

          done()
          return
        }

        const { replaced, changes } = yield VirtualOffers.get(offer.id).update(r.branch(r.row('state').ne(TRADE_STATE_CONFIRM), {
          state: TRADE_STATE_CONFIRM,
          botItemsIds: found
        }, {}), { returnChanges: true }).run(database.connection())

        if(replaced === 0) {
          const ids = _.pluck(_.pluck(result.changes, 'new_val'), 'id')

          yield BotItems.getAll(r.args(ids)).update({
            state: BOT_ITEM_STATE_AVAILABLE
          }).run(database.connection())

          done()
          return
        }

        if(replaced > 0) {
          publishNotification(changes[0].new_val)
        }

        const params = {
          ignoreBusy: true,
          assetIds: _.pluck(found, 'assetId'),
          meta: {
            pendingOfferId: offer.id
          },
          tradeLink: offer.tradeUrl,
          notifyUrl: offer.notifyUrl,
          steamId64: offer.steamId
        }

        withdraw([ params ], (err, response) => {
          if(!!err) {
            const errorMessage = err.message || err
            logger.error(`pollPendingOffers() withdraw ${err}`, {
              errorMessage,
              offerId: offer.id
            })

            VirtualOffers
              .get(offer.id)
              .update({
                errorMessage,
                hasError: true,
                retry: true,
                error: err,
                state: TRADE_STATE_ERROR,
                previousState: r.row('state'),
                errorAt: new Date()
              }, { returnChanges: true })
              .run(database.connection())
              .then(({ replaced, changes }) => {

                if(replaced > 0) {
                  publishNotification(changes[0].new_val)
                }

                done()
              })

            return
          }

          VirtualOffers
            .get(offer.id)
            .update({
              tradeOfferId: response.tradeOffers[0].id,
              lockedBotItemIds: _.pluck(found, 'id')
            }, { returnChanges: true })
            .run(database.connection())
            .then(({ replaced, changes }) => {

              if(replaced > 0) {
                publishNotification(changes[0].new_val)
              }

              done()
            })
        })
      })

      .catch(err => {
        logger.error(`pollPendingOffers() ${err.stack || err}`, {
          offerId: offer.id
        })
      })

    }, err => {
      if(!!err) {
        logger.error(`pollPendingOffers() async ${err.stack || err}`)
      }

      setTimeout(() => pollPendingOffers(), 3500)
    })
  })

  .catch(err => {
    logger.error(`pollPendingOffers() ${err}`)
    setTimeout(() => pollPendingOffers(), 2500)
  })
}

co(function* () {

  connection = yield r.connect(config.database)
  yield migrateDocuments(connection)

  // AMQP
  const amqpConnection  = yield amqplib.connect(config.amqp)
  amqpCh                = yield amqpConnection.createChannel()
  amqpCh.prefetch(25)
  amqpChSingle          = yield amqpConnection.createChannel()
  amqpChSingle.prefetch(1)

  // Deposit exchange
  yield amqpCh.assertQueue('skne.deposit', { durable: true })

  // Execute exchange
  yield amqpCh.assertQueue('skne.execute', { durable: true })

  // Control exchange
  amqpCh.assertExchange('skne.control', 'direct', {
    durable: true
  })

  // Withdraw exchange
  amqpCh.assertExchange('skne.withdraw', 'direct', {
    durable: true
  })

  // Virtual withdraw exchange
  amqpCh.assertExchange('skne.virtual.withdraw', 'direct', {
    durable: true
  })

  // Restock queue
  const singleQueue = yield amqpChSingle.assertQueue('skne', { durable: true })

  if(config.opskins) {
    yield amqpCh.bindQueue(singleQueue.queue, 'skne.virtual.withdraw', 'opskins')
  }

  yield amqpChSingle.consume(singleQueue.queue, onMessage)

  // Notify queue
  const notifyQueue = yield amqpCh.assertQueue('skne.notify', { durable: true })
  yield amqpCh.consume(notifyQueue.queue, onNotification)

  // if(config.opskins.apiKeys.length > 0) {
    // fixDelayedOPTrades()
  // }

  // RPC Server
  const port = 5080

  app.use(bodyParser.urlencoded({ extended: true }))
  app.use(bodyParser.json({ strict: false }))
  app.use(api())

  // Whitelist
  app.use('/rpc', (req, res, next) => {

    // Check if the ip connecting to the rpc is whitelisted
    const { whitelist } = config
    const ip = requestIp.getClientIp(req).replace(/^.*:/, '')

    if(whitelist.indexOf(ip) < 0) {
      return res.json({ error: 'No access: ' + ip })
    }

    next()
  })

  pollPendingOffers()
  pollOPInventory()

  // RPC
  app.use('/rpc', rpcServer.middleware())

  app.listen(port, err => {
    if(err) {
      logger.error(err)
      return
    }

    logger.info(`Server started on port ${port}`)
  })
})

.catch(logger.error)
