
import 'babel-core/register'
import 'babel-polyfill'

import fs from 'fs'
import co from 'co'
import OPSkinsAPI from '@opskins/api'
import TradeOfferManager, { EOfferFilter, ETradeOfferState } from 'steam-tradeoffer-manager'
import SteamUser from 'steam-user'
import { mapSeries, eachSeries } from 'async'
import SteamTotp from 'steam-totp'
import minimist from 'minimist'
import config from 'config'
import _ from 'underscore'
import GlobalOffensive from 'globaloffensive'

import {
  TRADE_STATE_SENT,
  TRADE_TYPE_INCOMING,
  TRADE_TYPE_WITHDRAW,
  TRADE_STATE_DECLINED,
  TRADE_TYPE_STORAGE,
  TRADE_TYPE_DEPOSIT,
  TRADE_STATE_QUEUED,
  TRADE_STATE_ERROR,
  TRADE_STATE_ACCEPTED,
  TRADE_STATE_ESCROW,
  TRADE_STATE_CONFIRM,

  TRADE_ITEM_STATE_PENDING,
  TRADE_ITEM_STATE_INSERTED,

  TRADE_VERIFICATION_STEP_PENDING
} from '../constant/trade'

import {
  CATEGORY_MELEE,
  CATEGORY_STICKER,
  CATEGORY_CASE,
  CATEGORY_OTHER,

  BOT_ITEM_STATE_AVAILABLE,
  BOT_ITEM_STATE_IN_USE,

  getItemCategory
} from '../constant/item'

import { amqpConnect, amqpCh, amqpConnection } from '../lib/amqp'
import r from '../lib/database'
import redis from '../lib/redis'
import Bots, { BotItems } from '../document/bot'
import TradeOffers, { PendingOffers } from '../document/offer'
import Items from '../document/item'
import logger from '../lib/logger'
import opskins from '../lib/opskins'

let amqpDepositCh = null
let botConfig     = null
let tradeLink     = null
let steamClient   = new SteamUser()
let csgo          = new GlobalOffensive(steamClient, 730)

let opskinsClient = null

let tradeManager  = new TradeOfferManager({
  steam: steamClient,
  domain: 'localhost',
  language: 'en',
  cancelTime: 60000 * 5,
  cancelOfferCount: 20
})

const pendingNewOffers = []

function isStorageBot() {
  return botConfig.storage || false
}

function groups() {
  return botConfig.groups || []
}

// checkOpenTrades
function checkIncomingTrades() {
  return new Promise((resolve, reject) => {

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    tradeManager.getOffers(EOfferFilter.ActiveOnly, today, (err, sent, received) => {
      if(err) {
        return reject(`Could not get open trades: ${err}`)
      }

      received.filter(o => o.state === 2).forEach(offer =>
        pendingNewOffers.push(offer)
      )

      resolve()
    })
  })

  .catch(err =>
    logger.error(`checkIncomingTrades ${err}`)
  )
}

function retryFn(fn, attempts, cb) {
  if(attempts <= 0) {
    return cb('Max attempts reached')
  }

  fn(function(err) {
    if(err) {
      setTimeout(() => retryFn(fn, attempts - 1, cb), 1500)
      return
    }

    cb.apply(null, arguments)
  }.bind(this))
}

function insertPendingItems() {
  return co(function* () {

    const steamId = steamClient.steamID.getSteamID64()
    const pending = yield TradeOffers
      .getAll([steamId, TRADE_ITEM_STATE_PENDING, TRADE_TYPE_DEPOSIT], { index: 'botItemStateType' })
      .filter({
        itemState: TRADE_ITEM_STATE_PENDING,
        type: TRADE_TYPE_DEPOSIT,
        state: TRADE_STATE_ACCEPTED
      })

    if(!pending.length) {
      return
    }

    return new Promise((resolve, reject) => {
      eachSeries(pending, (tradeOffer, done) => {
        if(tradeOffer.itemState !== TRADE_ITEM_STATE_PENDING) {
          return
        }

        logger.info(`Inserting ${tradeOffer.assetIds.length} bot items from offer ${tradeOffer.id}`)

        insertOfferItems(tradeOffer.offerId)
          .then(() => done())
          .catch(err => {
            logger.error(`insertPendingBotItems2() error: ${err}`)
            done()
          })
      }, (err) => {
        resolve()
      })
    })
  })

  .catch(err =>
    logger.error(`insertPendingItems() ${err}`)
  )
}

function checkSentOfferStates() {
  return co(function* () {
    const steamId = steamClient.steamID.getSteamID64()
    const offers = yield TradeOffers.getAll([ steamId, TRADE_STATE_CONFIRM ], [ steamId, TRADE_STATE_SENT ], [ steamId, TRADE_STATE_ESCROW ], { index: 'botState' })

    if(!offers.length) {
      return
    }

    logger.info(`checkSentOfferStates() Checking states of ${offers.length} sent offers`)

    for(let offer of offers) {

      if(offer.state === TRADE_STATE_CONFIRM) {
        yield new Promise((resolve, reject) => {
          tradeManager._community.acceptConfirmationForObject(botConfig.identitySecret, offer.offerId, err => {
            if(!err) {

              TradeOffers
                .get(offer.id)
                .update({ state: TRADE_STATE_SENT }, { returnChanges: true })
                .run()
                .then(({ replaced, changes }) => {
                  if(replaced > 0) {
                    broadcastOfferChange(changes[0].new_val)
                  }
                })

              return resolve()
            }

            resolve()
          })
        })
      }

      yield new Promise(resolve =>
        tradeManager.getOffer(offer.offerId, (err, offer) => {
          if(!!err) {
            return resolve()
          }

          co(onOfferChanged, offer, '').catch(err =>
            logger.error(`tradeManager.checkSentOfferStates ${err}`)
          )

          resolve()
        })
      )
    }
  })
}

function reloadInventory() {
  return co(function* () {
    const inventory = yield new Promise((resolve, reject) => {
      tradeManager.getInventoryContents(730, 2, true, (err, items) =>
        !!err ? reject(err.message) : resolve(items)
      )
    })

    const steamId = steamClient.steamID.getSteamID64()
    const stored = yield BotItems.getAll(steamId, { index: 'bot' })

    // Check for items removed
    const removed = stored.filter(botItem => {
      for(let item of inventory) {
        if(botItem.assetId === parseInt(item.id)) {
          return false
        }
      }

      return true
    })

    // Check for items added
    const added = inventory.filter(item => {
      for(let botItem of stored) {
        if(botItem.assetId === parseInt(item.id)) {
          return false
        }
      }

      return true
    })

    const botItems = []

    for(let item of added) {
      try {
        const formatted = yield formatSteamItem(item)
        botItems.push(formatted)
      } catch(e) {
        logger.error('reloadInventory', e)
      }
    }

    if(botItems.length > 0) {
      logger.info(`Automatically added ${added.length} items`)

      yield new Promise((resolve, reject) => {
        eachSeries(botItems, (botItem, done) => {

          r
            .branch(BotItems.getAll(botItem.assetId, { index: 'assetId' }).count().eq(0), BotItems.insert(botItem), false)
            .run()
            .then(() => done(), done)
        }, err =>
          !!err ? reject(err) : resolve()
        )
      })
    }

    if(removed.length > 0) {
      logger.info(`Automatically removed ${removed.length} items`)
      yield BotItems.getAll(r.args(removed.map(i => i.id))).delete()
    }
  })

  .catch(err => logger.error(`reloadInventory ${err}`))
}

const inspectQueue = []

function inspectItem(owner, assetId, d) {
  return new Promise(onFinish => {
    inspectQueue.push({
      d,
      owner,
      assetId,
      onFinish
    })
  })
}

function formatSteamItem(item, owner = null) {
  return co(function* () {
    const [ description ] = yield Items.getAll(item.market_hash_name, { index: 'name' })
    if(!description) {
      return Promise.reject(`Cannot find item ${item.market_hash_name}`)
    }

    const steamId = steamClient.steamID.getSteamID64()

    if(!owner) {
      owner = steamId
    }

    const category  = getItemCategory(item.market_hash_name)
    const actions   = item.market_actions

    let newItem = {
      ..._.pick(description, 'name', 'assetId', 'nameColor', 'tokens', 'basePrice', 'price', 'wear', 'icon', 'cleanName'),

      bot: steamId,
      createdAt: new Date(),
      state: BOT_ITEM_STATE_AVAILABLE,
      assetId: parseInt(item.id),
      name: item.market_hash_name,
      type: item.type,
      groups: groups(),

      rawItem: item
    }

    if(config.useCSGO && item.type.indexOf('Covert Knife') >= 0 && category === CATEGORY_MELEE && actions && actions.length > 0) {
      const inspectAction = actions.filter(action =>
        action.link && action.link.indexOf('csgo_econ_action_preview') >= 0
      )[0]

      if(inspectAction) {
        const match = inspectAction.link.match(/D(\d+)$/)
        if(!match || match.length < 2) {
          return Promise.reject(`${item.market_hash_name} Cannot get D value from ${inspectAction.link}`)
        }

        const { paintindex } = yield inspectItem(owner, item.id, match[1])

        const [ extraItem ] = config.extraItems.filter(i =>
          i.opskins.name === item.market_hash_name && i.paint === paintindex
        )

        if(extraItem) {
          newItem = {
            ...newItem,
            name: extraItem.name,
            baseName: item.name,
            paintIndex: paintindex
          }
        } else {
          // return Promise.reject(`Cannot find paint index ${paintindex} for ${item.name}`)
        }
      }
    }

    const [ itemDescription ] = yield Items.getAll(newItem.name, { index: 'name' })

    if(!itemDescription) {
      return Promise.reject(`Cannot find description for ${itemDescription}`)
    }

    delete itemDescription['id']

    return {
      ...itemDescription,
      ...newItem
    }
  })
}

  // const inspect

  // console.log(item)
  // console.log(typeof item.id)
  //
  // csgo.inspectItem(parseInt(item.id), inspectedItem => {
  //   console.log(inspectedItem)
  // })

  // return {
  //   bot,
  //
  //   createdAt: new Date(),
  //   state: BOT_ITEM_STATE_AVAILABLE,
  //   assetId: parseInt(item.id),
  //   name: item.market_hash_name,
  //   type: item.type,
  //   groups: groups(),
  //
  //   rawItem: item
  // }
// }

function* onIncomingOffer(offer) {
  const { id, partner } = offer
  logger.info(`Received new offer (${id}) from ${partner.getSteamID64()}`)

  let forceAccept = false

  if(groups().indexOf('opskins') >= 0) {
    forceAccept = yield new Promise((resolve, reject) => {
      opskins[0].getBotList((err, response) => {
        if(err) {
          return reject(err)
        }

        resolve(!!_.findWhere(response.bots, {
          id64: offer.partner.getSteamID64()
        }))
      })
    })
  }

  if(!forceAccept && !isStorageBot()) {
    offer.decline()
    return
  }

  // Whitelist admins & bots
  let whitelist = config.storageWhitelist || []

  const botIds = yield Bots.map(b => b('id'))
  whitelist.push(...botIds)

  if(!forceAccept && whitelist.indexOf(partner.getSteamID64()) < 0) {
    offer.decline()
    return
  }

  return new Promise((resolve, reject) => {

    if(whitelist.indexOf(partner.getSteamID64()) >= 0) {
      TradeOffers.insert({
        offerId: parseInt(id),
        type: TRADE_TYPE_STORAGE,
        state: TRADE_STATE_ACCEPTED,
        steamId64: offer.partner.getSteamID64(),
        createdAt: new Date(),
        bot: steamClient.steamID.getSteamID64(),
        assetIds: offer.itemsToReceive.map(i => parseInt(i.assetid)),
        itemNames: offer.itemsToReceive.map(i => i.market_hash_name),
        subtotal: Items.getAll(r.args(offer.itemsToReceive.map(i => i.market_hash_name)), { index: 'name' }).sum('basePrice'),

        giveAssetIds: offer.itemsToGive.map(i => parseInt(i.assetid)),
        giveItemNames: offer.itemsToGive.map(i => i.market_hash_name),
        givenItemsSubtotal: Items.getAll(r.args(offer.itemsToGive.map(i => i.market_hash_name)), { index: 'name' }).sum('basePrice'),
      }).run()
    }

    offer.accept((err, status) => {
      if(!!err) {
        return reject(err)
      }

      if(status === 'pending') {
        tradeManager._community.acceptConfirmationForObject(botConfig.identitySecret, offer.id, () => {})
      }

      insertOfferItems(offer.id)
      resolve()
    })
  })
}

function pollPendingNewOffers() {
  if(!pendingNewOffers.length) {
    return setTimeout(pollPendingNewOffers, 500)
  }

  const offer = pendingNewOffers.splice(0, 1)[0]

  co(onIncomingOffer, offer).then(() => pollPendingNewOffers(), err => {
    logger.error(`pollPendingNewOffers ${err}`)
    pollPendingNewOffers()
  })
}

function broadcastPendingOffer(params) {
  let servers = _.values(config.servers)

  if(!!params.notifyUrl) {
    servers = [ params.notifyUrl ]
  }

  _.uniq(servers).forEach(server => {
    amqpCh().sendToQueue('skne.notify', new Buffer(JSON.stringify({
      server,
      params,
      method: 'offer.change'
    })))
  })
}

function broadcastOfferChange(offer, oldOffer) {

  // Virtual Deposits
  if(!!offer.meta && !!offer.meta.pendingOfferId) {
    let update = {}

    if(offer.state === TRADE_STATE_DECLINED || offer.state === TRADE_STATE_ERROR) {
      update = {
        state: TRADE_STATE_DECLINED,
        hasTradeOfferError: offer.state === TRADE_STATE_ERROR,
        retry: true
      }
    } else if(offer.state === TRADE_STATE_SENT) {
      update = {
        state: TRADE_STATE_SENT,
        tradeOfferUrl: offer.tradeOfferUrl
      }
    } else if(offer.state === TRADE_STATE_ACCEPTED) {
      update = {
        state: TRADE_STATE_ACCEPTED,
        acceptedAt: new Date()
      }
    }

    if(Object.keys(update).length > 0) {
      PendingOffers
        .get(offer.meta.pendingOfferId)
        .update(update, { returnChanges: true })
        .run()
        .then(({ replaced, changes }) => {
          if(replaced > 0) {
            broadcastPendingOffer(changes[0].new_val)
          }
        })
    }
  }

  const servers = []

  if(!!offer.notifyUrl && servers.indexOf(offer.notifyUrl) < 0) {
    servers.push(offer.notifyUrl)
  }

  servers.forEach(server => {
    amqpCh().sendToQueue('skne.notify', new Buffer(JSON.stringify({
      method: 'trade.OnTradeOfferStateChange',
      server: server,
      params: offer
    })))
  })
}

function* onOfferChanged(offer, oldState) {
  if(offer.state === oldState) {
    return
  }

  const declinedStates = [
    ETradeOfferState.Declined,
    ETradeOfferState.Canceled,
    ETradeOfferState.Invalid,
    ETradeOfferState.InvalidItems,
    ETradeOfferState.CanceledBySecondFactor,
    ETradeOfferState.Countered,
  ]

  let tradeOfferState = null

  if(offer.state === ETradeOfferState.Active) {
    tradeOfferState = TRADE_STATE_SENT
  } else if(offer.state === ETradeOfferState.CreatedNeedsConfirmation) {
    tradeOfferState = TRADE_STATE_CONFIRM
  } else if(offer.state === ETradeOfferState.Accepted) {
    tradeOfferState = TRADE_STATE_ACCEPTED
  } else if(declinedStates.indexOf(offer.state) >= 0) {
    tradeOfferState = TRADE_STATE_DECLINED
  } else if(offer.state === ETradeOfferState.InEscrow) {
    tradeOfferState = TRADE_STATE_ESCROW
  }

  if(!tradeOfferState) {
    return
  }

  const update = {
    state: tradeOfferState,
    meta: r.row('meta').default({})
  }

  if(offer.state === ETradeOfferState.Accepted) {
    update.itemState = TRADE_ITEM_STATE_PENDING
  }

  const { replaced, changes }  = yield TradeOffers
    .getAll(parseInt(offer.id), { index: 'offerId' })
    .update(r.branch(r.row('state').ne(tradeOfferState), update, {}), { returnChanges: true })

  if(replaced === 0) {
    return
  }

  if(replaced > 0) {
    const tradeOffer = changes[0].new_val

    if(offer.state === ETradeOfferState.Accepted) {
      redis.del(`inventory:${tradeOffer.steamId64}`)

      if(tradeOffer.type === TRADE_TYPE_WITHDRAW) {
        const assetIDs = offer.itemsToGive

        yield BotItems
          .getAll(r.args(tradeOffer.assetIds), { index: 'assetId' })
          .delete()

        broadcastOfferChange(changes[0].new_val, changes[0].old_val)
      } else {
        insertOfferItems(offer.id)
      }
    } else if(offer.state === ETradeOfferState.Declined) {
      if(tradeOffer.type === TRADE_TYPE_WITHDRAW) {
        const assetIDs = offer.itemsToGive

        yield BotItems
          .getAll(r.args(tradeOffer.assetIds), { index: 'assetId' })
          .update({
            state: BOT_ITEM_STATE_AVAILABLE
          })
      }
    }

    if(offer.state !== ETradeOfferState.Accepted) {
      broadcastOfferChange(changes[0].new_val, changes[0].old_val)
    }
  }
}

function onMessage(msg) {
  const { fields: { exchange }, content } = msg

  switch(exchange) {
    case 'skne.control':

      let { action, ...control } = JSON.parse(content.toString())

      if(action === 'cancelOffer') {
        tradeManager.getOffer(control.offerId, (err, offer) => {
          if(!!err) {
            return amqpCh().ack(msg)
          }

          offer.decline(err => amqpCh().ack(msg))
        })
      }

      return
      break

    case 'skne.withdraw':
      const id = content.toString()

      co(function* () {

        const tradeOffer = yield TradeOffers.get(id)
        if(!tradeOffer) {
          return amqpCh().ack(msg)
        } else if(tradeOffer.verificationState === TRADE_VERIFICATION_STEP_PENDING) {
          return amqpCh().ack(msg)
        }

        const offer = tradeManager.createOffer(tradeOffer.tradeLink)

        offer.setMessage(`[${id}])`)
        offer.addMyItems(tradeOffer.assetIds.map(assetid => ({
          assetid,
          appid: 730,
          contextid: 2
        })))

        const offerStatus = yield new Promise((resolve, reject) => {
          offer.send((err, status) => {
            if(err) {

              BotItems
                .getAll(r.args(tradeOffer.assetIds), { index: 'assetId' })
                .update({
                  state: BOT_ITEM_STATE_AVAILABLE
                })
                .run()

              return reject(err)
            }

            resolve(status)
          })
        })

        yield TradeOffers
          .get(id)
          .update({
            offerId: parseInt(offer.id),
            state: TRADE_STATE_CONFIRM,
            hasError: false,
            errorResult: -1,
            tradeOfferUrl: `https://steamcommunity.com/tradeoffer/${offer.id}/`
          }, { returnChanges: true })
          .run()
          .then(({ replaced, changes }) => {
            if(replaced > 0) {
              broadcastOfferChange(changes[0].new_val)
            }
          })

          if(offerStatus === 'pending') {
            tradeManager._community.acceptConfirmationForObject(botConfig.identitySecret, offer.id, err => {
              if(err) {
                return
              }

              TradeOffers
                .get(id)
                .update({ state: TRADE_STATE_SENT }, { returnChanges: true })
                .run()
                .then(({ replaced, changes }) => {
                  if(replaced > 0) {
                    broadcastOfferChange(changes[0].new_val)
                  }
                })
            })
          }

        amqpCh().ack(msg)
      })

      .catch(err => {

        TradeOffers
          .get(id)
          .update({
            state: TRADE_STATE_DECLINED,
            hasError: true,
            error: err.message,
            errorResult: err.eresult || -1,
            maxRetries: 1,
            retryCount: r.row('retryCount').default(0).add(1),
          }, { returnChanges: true })
          .run()
          .then(({ replaced, changes }) => {

            if(replaced > 0) {

              BotItems
                .getAll(r.args(changes[0].new_val.assetIds), { index: 'assetId' })
                .update({
                  state: BOT_ITEM_STATE_AVAILABLE
                })
                .run()

              broadcastOfferChange(changes[0].new_val, changes[0].old_val)
            }
          })

        logger.error(`onMessage ${err}`, {
          tradeOfferId: content.toString()
        })

        amqpCh().ack(msg)
      })

      break

    default:
      amqpCh().ack(msg)
      break
  }
}

function onGroupMessage(msg) {
  console.log(msg.content.toString())

  // const { fields: { exchange }, content } = msg
  //
  // switch(exchange) {
  //   case 'skne.withdraw':
  //
  // }
}

function onDepositMessage(msg) {
  const id = msg.content.toString()

  co(function* () {
    const tradeOffers = yield TradeOffers
      .getAll(id)
      .filter({
        type: TRADE_TYPE_DEPOSIT,
        state: TRADE_STATE_QUEUED
      })

    if(!tradeOffers.length) {
      amqpDepositCh.ack(msg)
      return
    }

    const tradeOffer  = tradeOffers[0]
    const offer       = tradeManager.createOffer(tradeOffer.tradeLink)

    offer.setMessage(`[${tradeOffer.id}] Token: ${tradeOffer.securityToken}`)
    offer.addTheirItems(tradeOffer.assetIds.map(assetid => ({
      assetid,
      appid: 730,
      contextid: 2
    })))

    offer.send((err, status) => {
      if(err) {
        logger.error(`onDepositMessage (${tradeOffer.id}) ${err}`)

        TradeOffers
          .get(tradeOffer.id)
          .update({
            bot: steamClient.steamID.getSteamID64(),
            state: TRADE_STATE_DECLINED,
            hasError: true,
            error: err.message
          }, { returnChanges: true })
          .run()
          .then(({ replaced, changes }) => {
            if(replaced >= 0) {
              broadcastOfferChange(changes[0].new_val, changes[0].old_val)
            }
          })

        amqpDepositCh.ack(msg)
        return
      }

      TradeOffers
        .get(tradeOffer.id)
        .update({
          bot: steamClient.steamID.getSteamID64(),
          state: TRADE_STATE_SENT,
          offerId: parseInt(offer.id),
          tradeOfferUrl: `https://steamcommunity.com/tradeoffer/${offer.id}/`
        }, { returnChanges: true })
        .run()
        .then(({ replaced, changes }) => {
          if(replaced >= 0) {
            broadcastOfferChange(changes[0].new_val, changes[0].old_val)
          }
        })

      amqpDepositCh.ack(msg)
    })
  })

  .catch(err => {
    logger.error(`onDepositMessage ${err}`)
    amqpDepositCh.ack(msg)
  })
}

function insertOfferItems(offerId) {
  return co(function* () {

    const offer = yield new Promise((resolve, reject) => {
      tradeManager.getOffer(offerId, (err, offer) => {
        if(!!err) {
          return reject(err)
        }

        resolve(offer)
      })
    })

    const [ tradeOffer ] = yield TradeOffers.getAll(parseInt(offerId), { index: 'offerId' })

    if(offer.itemsToGive.length) {
      logger.info(`Removing ${offer.itemsToGive.length} bot items from offer ${offerId}`)
      yield BotItems.getAll(r.args(offer.itemsToGive.map(i => parseInt(i.assetid))), { index: 'assetId' }).delete()
    }

    if(offer.itemsToReceive.length) {
      const items = yield new Promise((resolve, reject) =>
        offer.getReceivedItems((err, items) => {
          if(err) {
            return reject(err)
          } else if(!items.length) {
            return reject('recieved items.length === 0')
          }

          resolve(items)
        })
      )

      // const botItems = items.map(item => ({
      //   offerId,
      //
      //   createdAt: new Date(),
      //   state: BOT_ITEM_STATE_AVAILABLE,
      //   bot: steamClient.steamID.getSteamID64(),
      //   assetId: parseInt(item.id),
      //   name: item.market_hash_name,
      //   type: item.type,
      //   tags: item.tags,
      //   originalOwner: offer.partner.getSteamID64(),
      //   groups: groups()
      // }))

      const botItems = []

      for(let item of items) {
        try {
          const formatted = yield formatSteamItem(item)
          botItems.push(formatted)
        } catch(e) {
          logger.error(`insertOfferItems ${e}`)
        }
      }

      const botItemIds = yield new Promise((resolve, reject) => {
        mapSeries(botItems, (item, done) => {
          co(function* () {
            const [ existing ] = yield BotItems.getAll(item.assetId, { index: 'assetId' })

            if(existing) {
              done(null, existing.id)
              return
            }

            const { generated_keys } = yield BotItems.insert(item)
            done(null, generated_keys[0])
          })

          .catch(done)
        }, (err, items) =>
          !!err ? reject(err) : resolve(items)
        )
      })

      const newItems = yield new Promise((resolve, reject) => {
        mapSeries(items, (item, done) => {

           co(function* () {
             const [ description ] = yield Items.getAll(item.market_hash_name, { index: 'name' })
             if(!description) {
               return reject(`Cannot find item ${item.market_hash_name}`)
             }

             done(null, {
               ..._.pick(description, 'name', 'assetId', 'nameColor', 'tokens', 'basePrice', 'price', 'wear', 'icon', 'cleanName'),
               assetId: parseInt(item.id)
             })
           })

           .catch(err => done(err))

        }, (err, items) =>
          !!err ? reject(err) : resolve(items)
        )
      })

      const updateResult = yield TradeOffers
        .getAll(parseInt(offerId), { index: 'offerId' })
        .update({
          botItemIds,
          items: newItems,
          itemState: 'INSERTED',
          assetIds: _.pluck(botItems, 'assetId')
        }, { returnChanges: true })

      if(updateResult.replaced > 0) {
        broadcastOfferChange(updateResult.changes[0].new_val, updateResult.changes[0].old_val)
      }
    }
  })

  .catch(err => {
    logger.error(`insertOfferItems ${err.stack || err}`)
  })
}

function onExecute(msg) {
  const action = JSON.parse(msg.content.toString())

  const respond = message => {
    amqpCh().sendToQueue(msg.properties.replyTo, new Buffer(JSON.stringify(message)), {
      correlationId: msg.properties.correlationId
    })
  }

  if(action.method === 'hasMobileAuth') {

    try {
      const offer = tradeManager.createOffer(action.params[0])

      offer.getUserDetails((error, me, them) => {
      	if(!!error) {
          return respond({
            error: error.message || 'Unknown error',
            success: false
          })
      	}
        // else if(them.escrowDays > 0) {
        //   return respond({
        //     error: 'Your steam account must use steam mobile auth to prevent a 15 day trade hold.',
        //     success: false
        //   })
        // }

        respond({
          success: true
        })
      })
    } catch(e) {
      respond({
        success: false,
        error: 'Uknown error, please make sure your trade url is valid'
      })
    }
  }

  amqpCh().ack(msg)
}

tradeManager.on('unknownOfferSent', offer => {
  offer.cancel()
})

tradeManager.on('newOffer', offer =>
  pendingNewOffers.push(offer)
)

tradeManager.on('sentOfferChanged', (offer, oldState) =>
  co(onOfferChanged, offer, oldState).catch(err =>
    logger.error(`tradeManager.sentOfferChanged ${err}`)
  )
)

tradeManager.on('receivedOfferChanged', (offer, oldState) =>
  co(onOfferChanged, offer, oldState).catch(err =>
    logger.error(`tradeManager.receivedOfferChanged ${err}`)
  )
)

steamClient.once('webSession', (session, cookies) => {
  tradeManager.setCookies(cookies, err => {
    if(!!err) {
      logger.error(`steamClient.webSession cannot set trade cookies: ${err}`)
      process.exit(0)
      return
    }

    co(function* (){
      steamClient.setPersona(SteamUser.Steam.EPersonaState.Online)
      logger.info(`Logged in`)

      if(config.useCSGO) {
        logger.info('Connnecting to CS:GO...')

        yield new Promise(resolve => {
          csgo.once('connectedToGC', () => resolve())

          steamClient.gamesPlayed(730, {
            force: true
          })
        })
      }

      tradeLink = yield new Promise((resolve, reject) => {
        tradeManager.getOfferToken((err, token) => {
          if(err) {
            return reject(err)
          }

          resolve(`https://steamcommunity.com/tradeoffer/new/?partner=${steamClient.steamID.accountid}&token=${token}`)
        })
      })

      const newBot = {
        tradeLink,

        steamId64: steamClient.steamID.getSteamID64(),
        display: botConfig.display,
        username: botConfig.username,
        name: steamClient.accountInfo.name,
        storage: isStorageBot(),
        groups: groups()
      }

      yield Bots.get(newBot.steamId64).replace(s =>
        r.branch(s.eq(null), {
          ...newBot,
          id: newBot.steamId64
        }, s.merge(newBot))
      )

      amqpDepositCh = yield amqpConnection().createChannel()
      amqpDepositCh.prefetch(1)

      if(!isStorageBot() && botConfig.acceptDeposits || groups().indexOf('deposit') >= 0) {
        yield amqpDepositCh.consume('skne.deposit', onDepositMessage)
      }

      for(let group of groups()) {
        let queueName = 'skne.deposit.' + group

        yield amqpDepositCh.assertQueue(queueName, { durable: true })
        yield amqpDepositCh.consume(queueName, onDepositMessage)
      }

      const controlQueue = yield amqpCh().assertQueue(`skne.bot.${steamClient.steamID.getSteamID64()}`, { durable: true })
      yield amqpCh().bindQueue(controlQueue.queue, 'skne.withdraw', steamClient.steamID.getSteamID64())
      yield amqpCh().bindQueue(controlQueue.queue, 'skne.control', steamClient.steamID.getSteamID64())

      yield amqpCh().consume('skne.execute', onExecute)
      yield amqpCh().consume(controlQueue.queue, onMessage)

      if(groups().indexOf('deposit') >= 0) {
        insertPendingItems()
      }

      if(config.useCSGO) {
        setTimeout(function loop() {
          if(inspectQueue.length <= 0) {
            return setTimeout(loop, 500)
          }

          const { owner, assetId, d, onFinish } = inspectQueue.splice(0, 1)[0]

          csgo.once('inspectItemInfo#' + assetId, itemInfo => {
            onFinish(itemInfo)
            setTimeout(loop, 1100)
          })

          csgo.inspectItem(owner, assetId, d)
        }, 1100)
      }

      yield reloadInventory()
      checkSentOfferStates()

      checkIncomingTrades()
      pollPendingNewOffers()

      setInterval(() => {
        // if(groups().indexOf('deposit') >= 0) {
        //   insertPendingItems()
        // }

        reloadInventory()
        checkSentOfferStates()
      }, 600000)

      if(groups().indexOf('opskins') >= 0 && !!botConfig.opskinsApiKey) {
        logger.info('Automatically selling items')

        opskinsClient = new OPSkinsAPI(botConfig.opskinsApiKey)

        if(botConfig.autoSellInventory) {
          autoSellInventory()
        }
      }

      // if(botConfig.storage && !!botConfig.automaticStoreGroup && botConfig.automaticStoreGroup.length) {
      //   const storageBots = yield Bots.filter(r.row('groups').default([]).contains(group =>
      //     r.expr(botConfig.automaticStoreGroup).contains(group)
      //   ))
      //
      //   startAutomaticStore(storageBots)
      // }

      logger.info(`Ready (${groups().join(', ')})`)
    })

    .catch(err =>
      logger.error(`steamClient.webSession error setting trade cookies: ${err}`)
    )
  })
})

function startAutomaticStore(bots) {
  const steamId = steamClient.steamID.getSteamID64()

  eachSeries(bots, (bot, done) => {
    co(function*() {
      const itemCount = yield BotItems.getAll(steamId, { index: 'bot' }).count()

      if(itemCount >= 500) {
        logger.error('startAutomaticStore', 'not accepting more until item count lowers', {
          itemCount
        })

        return done()
      }

      // const openStates = [ TRADE_STATE_SENT, TRADE_STATE_ACCEPTED, TRADE_STATE_CONFIRM ]
      // const openTrades = yield TradeOffers
      //   .getAll(openStates.map(s => ([ steamId, s ])), { index: 'botState' })
      //   .filter({ steamId64:})
      //   .count()
      //
      const { changes } = yield BotItems
        .getAll([ bot.id, BOT_ITEM_STATE_AVAILABLE ], { index: 'botState' })
        .limit(50)
        .update({
          state: BOT_ITEM_STATE_AVAILABLE
        }, { returnChanges: true })

      const availableItems = _.pluck(changes, 'new_val')

      if(availableItems.length <= 0) {
        return done()
      }

      const assetIds = _.pluck(availableItems, 'assetId')
      const itemNames = _.pluck(availableItems, 'name')

      const items = yield Items.getAll(r.args(itemNames), { index: 'name' })
      const subtotal  = items.reduce((t, i) => t + i.tokens, 0)
      const price  = items.reduce((t, i) => t + i.price, 0)

      const tradeOffer = {
        tradeLink,
        assetIds,
        subtotal,
        itemNames,

        createdAt: new Date(),
        type: TRADE_TYPE_WITHDRAW,
        state: TRADE_STATE_QUEUED,

        steamId64: steamId,
        notifyUrl: null,
        bot: bot.id,

        securityToken: '',

        meta: {},
        type: TRADE_TYPE_WITHDRAW,
        state: TRADE_STATE_QUEUED,

        botName: bot.display
      }

      const { generated_keys } = yield TradeOffers.insert(tradeOffer)
      amqpCh().publish('skne.withdraw', bot.id, new Buffer(generated_keys[0]), { persistent: true })

      logger.info('startAutomaticStore', `requesting ${assetIds.length} from bot ${bot.id}`)

      done()
    })

    .catch(done)
  }, err => {
    if(err) {
      logger.error('startAutomaticStore', err)
    }


    setTimeout(() => startAutomaticStore(bots), 60000)
  })
}

function autoSellInventory() {
  co(function* () {
    const activeTradeOffers = yield new Promise((resolve, reject) =>
      opskinsClient.getActiveTradeOffers((e, d) => !!e ? reject(e) : resolve(d))
    )

    const pickupOffersCount = _.filter(activeTradeOffers, o => o.type && o.type === 'pickup').length
    if(pickupOffersCount > 0) {
      logger.info('autoSellInventory', 'pickupOffersCount', pickup)
      return setTimeout(autoSellInventory, 2500)
    }

    const lowestPrices = yield new Promise((resolve, reject) => {
      redis.get('opskins:lowestPrices', (err, cached) => {
        if(!!err) {
          return reject(err)
        }

        if(!!cached) {
          return resolve(JSON.parse(cached))
        }

        opskinsClient.getLowestPrices(730, (err, prices) => {
          redis.set('opskins:lowestPrices', JSON.stringify(prices))
          redis.expire('opskins:lowestPrices', 30)
          resolve(prices)
        })
      })
    })

    const listingLimit = yield new Promise((resolve, reject) =>
      opskinsClient.getListingLimit((e, d) => !!e ? reject(e) : resolve(d))
    )

    const botItems = yield BotItems
      .getAll([ steamClient.steamID.getSteamID64(), BOT_ITEM_STATE_AVAILABLE ], { index: 'botState' })

    if(!botItems.length) {
      logger.info('autoSellInventory', 'botItems', botItems.length)
      return setTimeout(autoSellInventory, 10000)
    }

    const itemsToList = botItems
      .filter(i => !!lowestPrices[i.name] && lowestPrices[i.name].price >= 10)
      .map(i => ({
        appid: 730,
        contextid: 2,
        assetid: i.assetId,
        price: Math.max(2, lowestPrices[i.name].price)
      }))
      .slice(0, 100)

    if(!itemsToList.length) {
      logger.info('autoSellInventory', 'itemsToList', itemsToList)
      return setTimeout(autoSellInventory, 10000)
    }

    const response = yield new Promise((resolve, reject) =>
      opskinsClient.listItems(itemsToList, (e, d) => !!e ? reject(e) : resolve(d))
    )

    logger.info('autoSellInventory', `Listed ${response.sales.length} for sale`)
    setTimeout(autoSellInventory, 25000)
  })

  .catch(err => {
    logger.error('autoSellInventory', err)
    setTimeout(autoSellInventory, 10000)
  })
}

/*

function autoSellInventory() {
  logger.info('autoSellInventory', 'polling')

  co(function* () {
    const activeTradeOffers = yield new Promise((resolve, reject) =>
      opskinsClient.getActiveTradeOffers((e, d) => !!e ? reject(e) : resolve(d))
    )

    const pickupOffersCount = _.filter(activeTradeOffers, o => o.type && o.type === 'pickup').length
    logger.info('autoSellInventory', 'pickupOffersCount', pickupOffersCount)

    if(pickupOffersCount > 0) {
      return setTimeout(autoSellInventory, 2500)
    }

    const lowestPrices = yield new Promise((resolve, reject) => {
      redis.get('opskins:lowestPrices', (err, cached) => {
        if(!!err) {
          return reject(err)
        }

        if(!!cached) {
          return resolve(JSON.parse(cached))
        }

        opskinsClient.getLowestPrices(730, (err, prices) => {
          redis.set('opskins:lowestPrices', JSON.stringify(prices))
          redis.expire('opskins:lowestPrices', 30)
          resolve(prices)
        })
      })
    })

    const listingLimit = yield new Promise((resolve, reject) =>
      opskinsClient.getListingLimit((e, d) => !!e ? reject(e) : resolve(d))
    )

    const steamId = steamClient.steamID.getSteamID64()
    const storageBots = yield Bots
      .filter(r.row('id').ne(steamId))
      .map(b => b('id'))

    const botItemAssetIds = yield BotItems
      .getAll([ steamId, BOT_ITEM_STATE_AVAILABLE ], { index: 'botState' })
      .map(b => b('assetId'))

    const tradeOffers = _.uniq(yield TradeOffers
      .getAll(r.args(botItemAssetIds), { index: 'assetIds' })
      .filter(t =>
        t('state').eq(TRADE_STATE_ACCEPTED).and(r.expr([ ...storageBots, ...config.storageWhitelist]).contains(t('steamId64')))
      ), t => t.id)

    const availableAssetIds = tradeOffers
      .reduce((ids, t) => ids.concat(t.assetIds), [])
      .filter(id => botItemAssetIds.indexOf(id) >= 0)

    const botItems = yield BotItems.getAll(r.args(availableAssetIds), { index: 'assetId' })

    if(!botItems.length) {
      return setTimeout(autoSellInventory, 10000)
    }

    const itemsToList = botItems
      .filter(i => !!lowestPrices[i.name] && lowestPrices[i.name].price >= 10)
      .map(i => ({
        appid: 730,
        contextid: 2,
        assetid: i.assetId,
        price: Math.max(2, lowestPrices[i.name].price)
      }))
      .slice(0, 100)

    if(!itemsToList.length) {
      return setTimeout(autoSellInventory, 10000)
    }

    const response = yield new Promise((resolve, reject) =>
      opskinsClient.listItems(itemsToList, (e, d) => !!e ? reject(e) : resolve(d))
    )

    logger.info('autoSellInventory', `Listed ${response.sales.length} for sale`)
    setTimeout(autoSellInventory, 25000)
  })

  .catch(err => {
    logger.error('autoSellInventory', err)
    setTimeout(autoSellInventory, 10000)
  })
}

*/
steamClient.on('error', eresult =>
  logger.error(`Client error: ${eresult}`)
)

co(function* () {
  const argv = minimist(process.argv.slice(2))
  if(!argv._.length) {
    throw new Error('Invalid args')
  }

  const id = argv._[0]
  botConfig = config.bots[id]
  if(!botConfig) {
    throw new Error(`Cannot find bot config for ${id}`)
  }

  if(!fs.existsSync('./data')) {
    fs.mkdirSync('./data')
  }

  yield amqpConnect()
  amqpCh().prefetch(1)

  // Resume trade polling
  const pollDataLocation = `./data/polldata_${id}`
  if(fs.existsSync(pollDataLocation)) {
    try {
      tradeManager.pollData = JSON.parse(fs.readFileSync(pollDataLocation))
    } catch(err) {
      logger.error(`Cannot resume polling session: ${err}`)
    }
  }

  tradeManager.on('pollData', pollData => fs.writeFile(pollDataLocation, JSON.stringify(pollData)))

  const { username, password, display, sharedSecret } = botConfig

  logger.info(`Starting ${botConfig.display}`)

  steamClient.logOn({
    accountName: username,
    password: password,
    twoFactorCode: SteamTotp.generateAuthCode(sharedSecret)
  })
})

.catch(err => {
  logger.error(`Startup error: ${err}`)
})

setInterval(() => {
  logger.info('Auto restarting...')
  process.exit(0)
}, (60000) * 10)
