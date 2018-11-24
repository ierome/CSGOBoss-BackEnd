
import { Router } from 'express'
import co from 'co'
import numeral from 'numeral'

import Items from 'document/item'
import logger from 'lib/logger'
import r from 'lib/database'

function getItems(req, res) {
  const { query } = req.query

  co(function* () {
    let q = Items

    if(!!query && query.length > 0) {
      q = q.filter(r.row('name').match(`(?i)${query}`))
    }

    const items = yield q.orderBy(r.asc('name')).limit(15)

    res.json({
      items: items.map(item => ({
        ...item,

        title: item.name,
        image: item.icon,
        priceUSD: item.price,
        price: `$${numeral(item.price).format('0,0.00')}`
      }))
    })
  })

  .catch(err => {
    logger.error(`getItems: ${err}`)
    res.status(400).send('Please try again later')
  })
}

function postUpdateItem(req, res) {
  const { name } = req.params

  co(function* () {
    // Unsafe
    yield Items.getAll(name, { index: 'name' }).update(req.body.update)

    res.json({
      success: true
    })
  })

  .catch(err => {
    logger.error(`getItems: ${err}`)
    res.status(400).send('Please try again later')
  })
}

function getBlacklistedItems(req, res) {
  co(function* () {
    const items = yield Items.getAll(true, { index: 'blocked' }).orderBy(r.asc('name'))

    res.json({
      items
    })
  })

  .catch(err => {
    logger.error(`getBlacklistedItems: ${err}`)
    res.status(400).send('Please try again later')
  })
}

export default () => {
  const router = Router()
  router.get('/', getItems)
  router.post('/update/:name', postUpdateItem)
  router.get('/blacklist', getBlacklistedItems)
  return router
}
