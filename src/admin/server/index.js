
import 'babel-polyfill'

import co from 'co'
import http from 'http'
import express from 'express'
import config from 'config'
import bodyParser from 'body-parser'

import logger from 'lib/logger'
import r from 'lib/database'
import routes from './routes'
import { migrateDocuments } from 'lib/documents'

const app     = express()
const server  = new http.Server(app)

co(function* () {
  logger.info('SKNExchange Administration')

  app.use(bodyParser.urlencoded({ extended: true }))
  app.use(bodyParser.json({ strict: false }))
  app.use(routes())

  const { httpPort } = config.administration
  server.listen(httpPort, () => logger.info(`Binded to 0.0.0.0:${httpPort}`))
})

.catch(err => {
  logger.error(`startup error: ${err}`)
})
