
import { totp } from 'notp'
import base32 from 'thirty-two'
import config from 'config'
import request from 'request'

export const ITEM_WEARS = {
  'Factory New': 'FN',
  'Minimal Wear': 'MW',
  'Field-Tested': 'FT',
  'Well-Worn': 'WW',
  'Battle-Scarred': 'BS'
}

// authCode
function authCode() {
  return totp.gen(base32.decode(config.bitskins.secret))
}

// parseItemWear
function parseItemWear(name) {
  let idx = -1

  for(let i = 0; i < name.length; i++) {
    if(name.charAt(i) === '(') {
      idx = i
    }
  }

  if(idx >= 0) {
    const wear = name.substring(idx + 1, name.length - 1).trim()
    return !!ITEM_WEARS[wear] ? wear : ''
  }

  return ''
}

// formatItem
function formatItem({ item_id, market_hash_name, price, suggested_price, inspectable, inspect_link, image }) {
  const wear = parseItemWear(market_hash_name)
  let name = market_hash_name
  let sub = ''

  if(wear.length) {
    name = name.substring(0, name.length - wear.length - 2).trim()
  }

  const idx = name.indexOf('|')
  if(idx >= 0) {
    sub = name.substring(idx + 1)
    name = name.substring(0, idx)
  }

  return {
    name,
    sub,
    inspectable,
    image,
    wear,

    id: item_id,
    price: parseFloat(price),
    suggested_price: parseFloat(suggested_price),
    inspectLink: inspect_link,
    wearShort: ITEM_WEARS[wear],
    tokens: price * 1000
  }
}

export function getInventoryOnSale(opts = {}) {
  return new Promise((resolve, reject) => {
    request({
      url: 'https://bitskins.com/api/v1/get_inventory_on_sale',
      qs: {
        api_key: config.bitskins.apiKey,
        code: authCode(),
        ...opts
      },
      json: true
    }, (err, res, body) => {
      if(err) {
        return reject(err)
      } else if(body.status === 'fail') {
        return reject(body.data.error_message)
      }

      resolve({
        ...body.data,
        items: body.data.items.map(formatItem)
      })
    })
  })
}

export function buyItems(opts = {}) {
  return new Promise((resolve, reject) => {
    request({
      url: 'https://bitskins.com/api/v1/buy_item',
      json: {
        api_key: config.bitskins.apiKey,
        code: authCode(),
        auto_trade: false,
        ...opts
      }
    }, (err, res, body) => {

      if(err) {
        return reject(`buyItems() ${err}`)
      } else if(body.status === 'fail') {

        if(!!body.data.unavailable_item_ids) {
          return resolve({
            aborted: true,
            hasUnavailable: true
          })
        }

        return reject(`buyItems() ${body.data.error_message}`)
      }

      resolve(body.data)
    })
  })
}

export function withdrawItems(items, id, token) {
  if(!id || !token) {
    return Promise.reject('Missing id/token')
  }

  return new Promise((resolve, reject) => {
    request({
      url: 'https://bitskins.com/api/v1/withdraw_item',
      json: {
        api_key: config.bitskins.apiKey,
        code: authCode(),
        item_ids: items.join(','),
        to_id: id,
        to_token: token
      }
    }, (err, res, body) => {
      if(err) {
        return reject(`withdrawItems() ${err}`)
      } else if(body.status === 'fail') {
        return reject(`withdrawItems() ${body.data.error_message}`)
      }

      resolve(body.data)
    })
  })
}

export function getBuyHistory(page) {
  return new Promise((resolve, reject) => {
    request({
      url: 'https://bitskins.com/api/v1/get_buy_history',
      json: {
        api_key: config.bitskins.apiKey,
        code: authCode(),
        page: page || 1
      }
    }, (err, res, body) => {
      if(err) {
        return reject(`getBuyHistory() ${err}`)
      } else if(body.status === 'fail') {
        return reject(`getBuyHistory() ${body.data.error_message}`)
      }

      resolve(body.data)
    })
  })
}
