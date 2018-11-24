
import 'babel-polyfill'

import minimist from 'minimist'
import config from 'config'
import fs from 'fs'

import logger from './lib/logger'
import Bot from './lib/bot'

const argv = minimist(process.argv.slice(2))
if(!argv._.length) {
  logger.info('Missing bot')
  process.exit(0)
}

const { bots } = config
if(!bots || !bots[argv._[0]]) {
  logger.info('Could not find bot configuration')
  process.exit(0)
}

// Create data directory
if(!fs.existsSync('./data')) {
  fs.mkdirSync('./data')
}

const bot = new Bot(bots[argv._[0]])
bot.run()
