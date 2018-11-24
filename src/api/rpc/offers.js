
import _ from 'underscore'
import r from 'rethinkdb'

import { connection } from '../../lib/database'
import { BotItems, VirtualOffers, VirtualOffersGroup, TradeOffers } from '../../lib/documents'
import { TRADE_STATE_ACCEPTED, TRADE_STATE_QUEUED, TRADE_STATE_ERROR, TRADE_STATE_ESCROW, TRADE_STATE_CONFIRM, TRADE_STATE_SENT,
  TRADE_STATE_DECLINED, TRADE_STATE_PENDING } from '../../constant/trade'

import { BOT_ITEM_STATE_AVAILABLE } from '../../constant/item'
import { publishNotification, amqpChannel } from '../../lib/amqp'

const PENDING_STATES = [ TRADE_STATE_ACCEPTED, TRADE_STATE_QUEUED, TRADE_STATE_ERROR, TRADE_STATE_ESCROW, TRADE_STATE_CONFIRM, TRADE_STATE_SENT, TRADE_STATE_DECLINED, TRADE_STATE_PENDING ]

function* pending([{ steamId }]) {
  if(!steamId) {
    return done('SteamID64 is required')
  }

  const offers = yield VirtualOffers
    .getAll(r.args(PENDING_STATES.map(state => ([ steamId, state ]))), { index: 'steamIdState' })
    .orderBy(r.desc('createdAt'))
    .coerceTo('array')
    .run(connection())

  const groups = yield VirtualOffersGroup
    .getAll(r.args(_.pluck(_.uniq(offers), 'virtualOfferGroupId')))
    .coerceTo('array')
    .run(connection())

  return {
    offers
    // groups
  }
}

function* retry([{ id, steamId, tradeUrl }]) {
  // const offers = yield TradeOffers
  //   .getAll(id)
  //   .filter({ steamId64: steamId })
  //   .coerceTo('array')
  //   .run(connection())
  //
  // if(!offers.length) {
  //   return Promise.reject('Cannot find offer')
  // }
  //
  // const offer = offers[0]
  //
  // if(offer.type === 'WITHDRAW' && offer.state === TRADE_STATE_DECLINED) {
  //   let { replaced, changes } = yield TradeOffers
  //     .get(id)
  //     .update(r.branch(r.row('state').eq(TRADE_STATE_DECLINED), {
  //       tradeLink: tradeUrl,
  //       state: TRADE_STATE_QUEUED,
  //       retry: false,
  //       retries: 0
  //     }, {}), { returnChanges: true })
  //     .run(connection())
  //
  //   if(replaced > 0) {
  //     const change = changes[0].new_val
  //
  //     publishNotification(change, 'trade.OnTradeOfferStateChange')
  //
  //     if(!!change.meta.pendingOfferId) {
  //       let { replaced, changes } = yield VirtualOffers
  //         .get(change.meta.pendingOfferId)
  //         .update({
  //           tradeUrl,
  //           tradeLink: tradeUrl,
  //           state: TRADE_STATE_ESCROW
  //         }, { returnChanges: true })
  //         .run(connection())
  //
  //       if(replaced > 0) {
  //         publishNotification(changes[0].new_val)
  //       }
  //
  //       amqpChannel().publish('skne.withdraw', offer.bot, new Buffer(offer.id), { persistent: true })
  //     }
  //   }
  // }
}

function* retryVirtual([{ id, steamId, tradeUrl }]) {
  const offers = yield VirtualOffers
    .getAll(id)
    .filter({ steamId: steamId, retry: true })
    .coerceTo('array')
    .run(connection())

  if(!offers.length) {
    return Promise.reject('Cannot find offer')
  }

  const offer = offers[0]

  if(!!offer.tradeOfferId && (offer.state === TRADE_STATE_DECLINED || offer.state === TRADE_STATE_ERROR)) {

    if(!!offer.lockedBotItemIds && offer.lockedBotItemIds.length) {
      yield BotItems.getAll(r.args(offer.lockedBotItemIds)).update({
        state: BOT_ITEM_STATE_AVAILABLE
      }).run(connection())
    }

    let { replaced, changes } = yield VirtualOffers
      .get(offer.id)
      .update(r.branch(r.row('state').ne(TRADE_STATE_PENDING), {
        tradeUrl,

        state: TRADE_STATE_PENDING,
        lockedBotItemIds: [],
        retry: false,
        error: null,
        errorAt: null,
        errorMessage: null,
        tradeOfferId: null,
        hasError: false,
        retries: 0,
        manuallyRetried: r.row('manuallyRetried').default(0).add(1),
        previousOffers: r.row('previousOffers').default([]).append(r.row('tradeOfferId'))
      }, {}), { returnChanges: true })
      .run(connection())

    if(replaced > 0) {
      publishNotification(changes[0].new_val)
    }

    return
  }

  if(offer.state === TRADE_STATE_ERROR) {
    if(offer.previousState === TRADE_STATE_CONFIRM) {

      let { replaced, changes } = yield VirtualOffers
        .get(offer.id)
        .update(r.branch(r.row('state').eq(TRADE_STATE_ERROR), {
          tradeUrl,

          state: TRADE_STATE_ESCROW,
          retry: false,
          error: null,
          errorAt: null,
          errorMessage: null,
          hasError: false,
          retries: 0,
          manuallyRetried: r.row('manuallyRetried').default(0).add(1)
        }, {}), { returnChanges: true })
        .run(connection())

      if(replaced > 0) {
        publishNotification(changes[0].new_val)
      }

      return
    } else if(offer.previousState === TRADE_STATE_QUEUED) {

      let { replaced, changes } = yield VirtualOffers
        .get(offer.id)
        .update({
          tradeUrl,

          state: TRADE_STATE_QUEUED,
          retry: false,
          error: null,
          errorAt: null,
          errorMessage: null,
          hasError: false,
          retries: 0,
          manuallyRetried: r.row('manuallyRetried').default(0).add(1)
        }, { returnChanges: true })
        .run(connection())

      if(replaced > 0) {
        publishNotification(changes[0].new_val)
      }

      amqpChannel().publish('skne.virtual.withdraw', offer.provider, new Buffer(offer.id), {
        persistent: true
      })

      return
    } else if(offer.previousState === TRADE_STATE_ESCROW && offer.hasPurchaseResponse) {
      // Failed during withdraw?

      let { replaced, changes } = yield VirtualOffers
        .get(offer.id)
        .update({
          tradeUrl,
          
          state: TRADE_STATE_PENDING,
          retry: false,
          error: null,
          errorAt: null,
          errorMessage: null,
          escrowAt: r.now(),
          hasError: false,
          retries: 0,
          manuallyRetried: r.row('manuallyRetried').default(0).add(1)
        }, { returnChanges: true })
        .run(connection())

      if(replaced > 0) {
        publishNotification(changes[0].new_val)
      }

      // amqpChannel().publish('skne.virtual.withdraw', offer.provider, new Buffer(offer.id), {
      //   persistent: true
      // })

      return
    }
  }

  // if(!!offer.tradeOfferId) {
  //   return yield retry([{
  //     steamId,
  //     tradeUrl,
  //
  //     id: offer.tradeOfferId
  //   }])
  // }
}

function* cancel([{ id }]) {
  console.log(id)
}

function* requeue([{ id }]) {
  const [ offer ] = yield TradeOffers
    .getAll(id)
    .filter({ state: 'QUEUED' })
    .coerceTo('array')
    .run(connection())

  if(!offer) {
    return Promise.reject('Cannot find trade offer')
  }

  if(offer.type === 'DEPOSIT') {
    let queueName = 'skne.deposit'

    if(!!offer.depositGroup) {
      queueName += '.' + offer.depositGroup
    }

    amqpChannel().sendToQueue(queueName, new Buffer(offer.id), { persistent: true })
    return
  }

  return Promise.reject('Cannot requeue offer')
}

export default {
  pending,
  retryVirtual,
  retry,
  cancel,

  requeue
}
