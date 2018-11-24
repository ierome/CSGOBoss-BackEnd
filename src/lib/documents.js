
import { eachSeries } from 'async'
import r from 'rethinkdb'

export const TradeOffers  = r.table('TradeOffers')
export const VirtualOffers  = r.table('PendingOffers')
export const VirtualOffersGroup  = r.table('VirtualOffersGroup')
export const Items        = r.table('Items')
export const Bots         = r.table('Bots')
export const BotItems     = r.table('BotItems')
export const Transfers    = r.table('Transfers')

// migrateDocuments
export function migrateDocuments(connection) {
  const steps = [
    r.tableCreate('Transfers'),
    Transfers.indexWait(),

    r.tableCreate('PendingOffers'),
    VirtualOffers.indexCreate('state'),
    VirtualOffers.indexCreate('steamId'),
    VirtualOffers.indexCreate('steamIdState', row => [row('steamId'), row('state')]),
    VirtualOffers.indexCreate('incomingOfferIds', { multi: true }),
    // VirtualOffers.indexCreate('itemIds', { multi: true }),
    VirtualOffers.indexCreate('itemIdState', offer =>
      offer('itemIds').map(id => [ id, offer('state') ])
    , { multi: true }),
    VirtualOffers.wait(),
    VirtualOffers.indexWait(),

    r.tableCreate('VirtualOffersGroup'),
    VirtualOffersGroup.wait(),
    VirtualOffersGroup.indexWait(),

    r.tableCreate('Bots'),
    Bots.wait(),
    Bots.indexCreate('steamId64'),
    Bots.indexCreate('username'),
    Bots.indexCreate('groups', { multi: true }),
    Bots.indexWait(),

    r.tableCreate('Items'),
    Items.wait(),
    Items.indexCreate('name'),
    Items.indexCreate('cleanName'),
    Items.indexCreate('blocked'),
    Items.indexWait(),

    r.tableCreate('BotItems'),
    BotItems.wait(),
    BotItems.indexCreate('bot'),
    BotItems.indexCreate('offerId'),
    BotItems.indexCreate('name'),
    BotItems.indexCreate('state'),
    BotItems.indexCreate('assetId'),
    BotItems.indexCreate('assetIdState', row =>
      [row('assetId'), row('state')]
    ),
    BotItems.indexCreate('botState', row =>
      [row('bot'), row('state')]
    ),

    BotItems.indexCreate('groupsState', row =>
      row('groups').map(group =>
        [ group, row('state') ]
      )
    , { multi: true }),

    BotItems.indexCreate('groupsAssetId', row =>
      row('groups').map(group =>
        [ group, row('assetId') ]
      )
    , { multi: true }),

    BotItems.indexCreate('groupsStateTokens', row =>
      row('groups').map(group =>
        [ group, row('state'), row('tokens') ]
      )
    , { multi: true }),

    BotItems.indexCreate('assetIdState', row =>
      [row('assetId'), row('state')]
    ),
    BotItems.indexCreate('nameState', row =>
      [row('name'), row('state')]
    ),
    BotItems.indexCreate('idState', row =>
      [row('id'), row('state')]
    ),
    BotItems.indexWait(),

    r.tableCreate('TradeOffers'),
    TradeOffers.wait(),
    TradeOffers.indexCreate('offerId'),
    TradeOffers.indexCreate('state'),
    TradeOffers.indexCreate('type'),
    TradeOffers.indexCreate('steamId64'),
    TradeOffers.indexCreate('bot'),
    TradeOffers.indexCreate('offerId'),
    TradeOffers.indexCreate('itemState'),
    TradeOffers.indexCreate('assetIds', { multi: true }),
    TradeOffers.indexCreate('botItemState', row => [row('bot'), row('itemState')]),
    TradeOffers.indexCreate('botState', row => [row('bot'), row('state')]),
    TradeOffers.indexCreate('botTypeState', row => [row('bot'), row('type'), row('state')]),
    TradeOffers.indexCreate('botItemStateType', row => [row('bot'), row('itemState'), row('type')]),
    TradeOffers.indexCreate('steamId64Type', row =>[row('steamId64'), row('type')]),
    TradeOffers.indexCreate('typeState', row => [row('type'), row('state')]),
    TradeOffers.indexWait()
  ]

  return new Promise((resolve, reject) => {
    eachSeries(steps, (query, done) =>
      query.run(connection, () => done())
    , () => resolve())
  })
}
