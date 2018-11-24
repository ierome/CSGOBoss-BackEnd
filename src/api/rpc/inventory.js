
import _ from 'underscore'
import r from 'rethinkdb'
import randomstring from 'randomstring'

import { chunk } from '../../lib/util'
import { connection } from '../../lib/database'
import { amqpChannel, publishNotification } from '../../lib/amqp'
import { VirtualOffers, VirtualOffersGroup, Items } from '../../lib/documents'
import { TRADE_TYPE_VIRTUAL, TRADE_STATE_QUEUED } from '../../constant/trade'
import opskins from '../../lib/opskins'

const MAX_UNIQUE_ITEM_PER_OFFER = 10
const MAX_UNIQUE_ITEM_COUNT = 75

function* virtualWithdraw([ params ], done) {
  if(!opskins.length) {
    return Promise.reject('OPSkins is currently not available')
  }

  const { notifyUrl, steamId, tradeUrl, itemNames, meta = {} } = params

  const uniqueItems = _.uniq(itemNames)
  if(uniqueItems.length <= 0) {
    return Promise.reject('Empty items list given')
  }

  const allItems = _
    .chain(yield Items
      .getAll(r.args(uniqueItems), { index: 'name' })
      .coerceTo('array')
      .run(connection())
    )
    .map(item => [item.name, item])
    .object()
    .value()

  if(Object.keys(allItems).length !== _.uniq(itemNames).length) {
    return Promise.reject('Items length mismatch')
  }

  // Create group
  const { generated_keys: [ virtualOfferGroupId ] } = yield VirtualOffersGroup.insert({
    steamId,
    itemNames,
    createdAt: new Date(),
    virtualOfferIds: []
  }).run(connection())

  // Seperate by item type and then by amount per type
  const offers = []
  const itemChunks = chunk(uniqueItems, MAX_UNIQUE_ITEM_PER_OFFER)
  const itemCounts = _.countBy(itemNames)

  itemChunks.forEach(itemChunk => {
    const items = _
      .chain(itemChunk)
      .map(itemName =>
        Array.from({ length: itemCounts[itemName] }, () => allItems[itemName])
      )
      .reduce((arr, items) => [ ...arr, ...items ], [])
      .value()

    const chunks = chunk(items, MAX_UNIQUE_ITEM_COUNT)

    offers.push(...chunks.map(chunk => ({
      meta,
      steamId,
      itemNames,
      notifyUrl,
      tradeUrl,
      virtualOfferGroupId,

      createdAt: new Date(),
      subtotal: _.reduce(chunk, (t, i) => t + i.tokens, 0),
      itemNames: _.pluck(chunk, 'name'),
      provider: 'opskins',
      type: TRADE_TYPE_VIRTUAL,
      state: TRADE_STATE_QUEUED,

      opBot: opskins[0]._steamId
    })))
  })

  const { inserted, generated_keys, changes } = yield VirtualOffers
    .insert(offers, { returnChanges: true })
    .run(connection())

  if(inserted <= 0) {
    return Promise.reject('Did not insert virtual offers')
  }

  yield VirtualOffersGroup.get(virtualOfferGroupId).update({
    virtualOfferIds: generated_keys
  }).run(connection())

  _.pluck(changes, 'new_val').forEach(offer => {
    publishNotification(offer)

    amqpChannel().publish('skne.virtual.withdraw', offer.provider, new Buffer(offer.id), {
      persistent: true
    })
  })

  return {
    virtualOfferGroupId,
    virtualOfferIds: generated_keys
  }
}

export default {
  virtualWithdraw
}
