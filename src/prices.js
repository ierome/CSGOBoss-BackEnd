
// import 'babel-polyfill'

import r from 'rethinkdb'
import request from 'request'
import config from 'config'
import co from 'co'
import _ from 'underscore'
import { eachSeries, parallelLimit } from 'async'

import { BotItems, Items, migrateDocuments } from './lib/documents'
import logger from './lib/logger'
import { getWear, isStatTrak, isSouvenir, getItemCategory } from './constant/item'

function getPrices() {
  return new Promise((resolve, reject) => {
    request({ url: config.prices.steamanalyst, json: true }, (err, res, body) => {
      const results = !err ? (body.results || []) : []

      if(!!err) {
        logger.error(`getPrices() ${err}`)
      }

      results.push(...config.extraItems.map(item => ({
        ...item,
        market_name: item.name,
        current_price: item.price,
        img: item.image,
        extra: true
      })))

      const items = _
        .chain(results)
        .map(item => [item.market_name, item])
        .object()
        .value()

      resolve(items)
    })
  })
}

function getItems() {
  return new Promise((resolve, reject) => {
    request({
      url: `http://api.csgo.steamlytics.xyz/v1/items?key=${config.prices.steamlytics}`,
      json: true
    }, (err, res, body) => {
      const results = !err ? (body.items || []) : []

      if(!!err) {
        logger.error(`getItems() ${err}`)
      }

      results.push(...config.extraItems.map(item => ({
        market_hash_name: item.name,
        quality_color: item.qualityColor,
        name_color: item.nameColor
      })))

      const items = _
        .chain(results)
        .map(item => [item.market_hash_name, item])
        .object()
        .value()

      resolve(items)
    })
  })
}

function getOPItems() {
  return new Promise((resolve, reject) => {
    request({
      url: 'https://files.opskins.media/file/opskins-static/pricelist/730.json',
      json: true
    }, (err, res, body) => {
      resolve(body)
    })
  })
}

function cleanItemName(name) {
  let idx = -1

  for(let i = 0; i < name.length; i++) {
    if(name.charAt(i) === '(') {
      idx = i
    }
  }

  if(idx > 0) {
    name = name.substring(0, idx)
  }

  return name.trim()
}

co(function* () {
  const connection = yield r.connect(config.database)
  yield migrateDocuments(connection)

  const prices          = yield getPrices()
  const items           = yield getItems()
  const opItems         = yield getOPItems()

  const allItems = _
    .chain(yield Items.coerceTo('array').run(connection))
    .map(item => [item.name, item])
    .object()
    .value()

  const tasks = []

  _.each(prices, (item, key) => {
    const description = items[key]

    if(!description) {
      return
    }

    let price = parseFloat(item.avg_price_7_days_raw || (item.suggested_amount_avg_raw || item.current_price))
    if(!price) {
      return
    }

    let blocked = !!item.suspicious

    if(item.ongoing_price_manipulation) {
      if(item.safe_price) {
        price = parseFloat(item.safe_price)
      } else {
        // blocked = true
        // price = 0
      }
    }

    let hasJumps = false
    if(!blocked && !item.avg_price_7_days_raw) {
      const opItem = opItems[key]

      if(opItem) {
        let lastPrice = -1

        for(let k in opItem) {

          if(lastPrice !== -1) {
            const pct = opItem[k].price * 0.20
            const diff = Math.abs(opItem[k].price - lastPrice)

            if(diff >= pct) {
              hasJumps = true
              blocked = true
              break
            }
          }

          lastPrice = opItem[k].price
        }
      }
    }

    const markup    = config.prices.markups.reduce((c, m) => price >= m.minimum ? m.markup : c, config.prices.markups[0].markup)
    const discount  = config.prices.discounts.reduce((c, m) => price <= m.under ? m.discount : c, 0)

    if(discount > 0) {
      price = Math.max(0.01, price - (price * discount))
    }

    let markedUpPrice = price * markup

    if(!!allItems[item.market_name]) {
      const { customPrice } = allItems[item.market_name]

      if(customPrice > 0) {
        markedUpPrice = customPrice
        price = markedUpPrice / markup
        console.log(`Custom Price: ${item.market_name}\t\tDeposit: ${price} Withdraw: ${markedUpPrice}`)
      }
    }

    let update = {
      hasJumps,

      price: markedUpPrice,
      icon: item.img,
      name: item.market_name,
      cleanName: cleanItemName(item.market_name),
      wear: -1,
      basePrice: price,
      baseTokens: (price * config.tokenMultiplier),
      tokens: (markedUpPrice * config.tokenMultiplier),
      createdAt: new Date(),
      qualityColor: `#${description.quality_color}`,
      nameColor: `#${description.name_color}`,
      wear: getWear(item.market_name),
      souvenir: isSouvenir(item.market_name),
      statTrak: isStatTrak(item.market_name),
      category: getItemCategory(item.market_name),
      extra: !!item.extra && item.extra,
      analyst: item
    }

    if(!!item.opskins) {
      update.opskins = item.opskins
    }

    if(!!config.items[item.market_name]) {
      update = {
        ...update,
        ...config.items[item.market_name]
      }
    }

    tasks.push((done) => {
      let promise

      if(!!allItems[item.market_name]) {
        // update['icon'] = r.row('icon')
        promise = Items.getAll(item.market_name, { index: 'name' }).update({
          ...update,
          blocked: allItems[item.market_name].forceAllow ? false : allItems[item.market_name].forceBlocked ? true : blocked,
        }).run(connection)

        promise = promise.then(() =>
          BotItems.getAll(item.market_name, { index: 'name' }).update(
            _.pick(allItems[item.market_name], 'name', 'assetId', 'nameColor', 'tokens', 'basePrice', 'price', 'wear', 'icon', 'cleanName')
          ).run(connection)
        )
      } else {
        promise = Items.insert(update).run(connection)
      }

      promise.then(() => done(), done)
    })
  })

  console.log(`Updating ${tasks.length} items...`)

  parallelLimit(tasks, 250, err => {
    if(err) {
      logger.error(err)
    }

    logger.info('Update completed')
    connection.close()
  })
})
.catch(logger.error)
