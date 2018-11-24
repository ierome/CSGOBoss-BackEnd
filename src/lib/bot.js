
import fs from 'fs'
import redis from 'redis'
import SteamTotp from 'steam-totp'
import SteamUser from 'steam-user'
import TradeOfferManager, { EOfferFilter, ETradeOfferState } from 'steam-tradeoffer-manager'
import SteamCommunity from 'steamcommunity'
import r from 'rethinkdb'
import bluebird from 'bluebird'
import co from 'co'
import amqplib from 'amqplib'
import { eachSeries, mapSeries } from 'async'
import config from 'config'
import schedule from 'node-schedule'
import numeral from 'numeral'
import _ from 'underscore'
import randomstring from 'randomstring'

import {
  CATEGORY_MELEE,
  CATEGORY_STICKER,
  CATEGORY_CASE,
  CATEGORY_OTHER,

  BOT_ITEM_STATE_AVAILABLE,
  BOT_ITEM_STATE_IN_USE,
} from '../constant/item'

import { tokenAmount } from './tokens'
import {
  VirtualOffers,
  TradeOffers,
  Bots,
  BotItems,
  Items,
  migrateDocuments
} from './documents'

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

import logger from './logger'
import opskins from './opskins'

// P R O M I S E S = ^ )
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

export default class Bot {
  constructor(botConfig) {
    Object.assign(this, {
      maxOpenTrades: 3,
      minDepositAmount: 1000,
      maxItemsDepositAmount: 50,
      acceptIncomingTrades: true,
      acceptDeposits: true,
      tradeLink: '',
      notifyServers: botConfig.notifyServers || [],
      automaticStoreGroup: [],
      groups: [],
      ...botConfig
    })

    this.redisClient = redis.createClient(config.redis)
    this.client = new SteamUser()
    this.community = new SteamCommunity()
    this.manager = new TradeOfferManager({
      'steam': this.client,
      'domain': 'localhost',
      'language': 'en',
      'cancelTime': 60000 * 5,
       cancelOfferCount: 20
    })

    // Resume polling
    this.pollDataLocation = `./data/polldata_${this.username}`
    if(fs.existsSync(this.pollDataLocation)) {
      this.manager.pollData = JSON.parse(fs.readFileSync(this.pollDataLocation))
    }
  }

  run() {
    logger.info(`Starting ${this.display}`)

    co(function* () {
      this.connection = yield r.connect({
        db: 'sknexchange',
        name: 'sknexchange'
      })

      yield migrateDocuments(this.connection)

      const amqpConnection  = yield amqplib.connect('amqp://localhost')

      this.amqpCh           = yield amqpConnection.createChannel()
      this.amqpCh.prefetch(1)

      this.amqpDepositCh    = yield amqpConnection.createChannel()
      this.amqpDepositCh.prefetch(1)

      this.client.on('error', this.onError.bind(this))
      this.client.on('webSession', this.onWebSession.bind(this))
      this.client.on('loggedOn', this.onLoggedOn.bind(this))

      this.client.on('disconnected', () => {
        logger.error('Logged out, attempting to log back in...')

        setTimeout(() => {
          logger.info('Attempting to log back in...')

          this.client.logOn({
            accountName: this.username,
            password: this.password,
            twoFactorCode: SteamTotp.generateAuthCode(this.sharedSecret)
          })
        }, 5000)
      })

      this.manager.on('newOffer', this.onNewTradeOffer.bind(this))
      this.manager.on('sentOfferChanged', this.onOfferChanged.bind(this))
      this.manager.on('receivedOfferChanged', this.onOfferChanged.bind(this))
      this.manager.on('realTimeTradeCompleted', offer => console.log(offer.id + ' is now done'))
      this.manager.on('pollData', pollData => fs.writeFile(this.pollDataLocation, JSON.stringify(pollData)))

      this.community.on('confirmationAccepted', conf => {
        console.log(conf)
      })

      this.client.logOn({
        accountName: this.username,
        password: this.password,
        twoFactorCode: SteamTotp.generateAuthCode(this.sharedSecret)
      })
    }.bind(this))

    .catch(err => logger.error(err))
  }

  onError({ eresult }) {
    switch(eresult) {
      case SteamUser.Steam.EResult.InvalidPassword:
        logger.error('Error authenticating (Needs auth code?)', { eresult })
        break
      case SteamUser.Steam.EResult.InvalidLoginAuthCode:
        logger.error('Invalid auth code', { eresult })
        break
      default:
        logger.error('Steam login error', { eresult })
        break
    }
  }

  onExecute(msg) {
    const action = JSON.parse(msg.content.toString())

    const respond = message => {
      this.amqpDepositCh.sendToQueue(msg.properties.replyTo, new Buffer(JSON.stringify(message)), {
        correlationId: msg.properties.correlationId
      })
    }

    if(action.method === 'hasMobileAuth') {
      try {
        const offer = this.manager.createOffer(action.params[0])

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

    this.amqpDepositCh.ack(msg)
  }

  onDeposit(msg) {
    const id = msg.content.toString()

    co(function* () {
      logger.info(`Sending deposit #${id}`)

      const tradeOffers = yield TradeOffers
        .getAll(id)
        .filter({
          type: TRADE_TYPE_DEPOSIT,
          state: TRADE_STATE_QUEUED
        })
        .coerceTo('array')
        .run(this.connection)

      if(!tradeOffers.length) {
        logger.error(`Could not find deposit #${id}`)
        this.amqpDepositCh.ack(msg)
        return
      }

      const tradeOffer  = tradeOffers[0]
      const offer       = this.manager.createOffer(tradeOffer.tradeLink)

      offer.setMessage(`Security Token: ${tradeOffer.securityToken}`)
      offer.addTheirItems(tradeOffer.assetIds.map(assetid => ({
        assetid,
        appid: 730,
        contextid: 2
      })))

      offer.send((err, status) => {
        if(err) {
          logger.info(`Could not send offer #${id}: ${err}`)

          TradeOffers
            .get(tradeOffer.id)
            .update({
              bot: this.steamId,
              state: TRADE_STATE_DECLINED,
              hasError: true,
              error: err.message
            }, { returnChanges: true })
            .run(this.connection)
            .then(({ changes }) => {
              if(changes && changes.length) {
                this.notifyTradeOfferChange(changes[0].new_val, changes[0].old_val)
              }
            })
            .catch(err => {
              logger.error(`onDeposit() Cannot update trade offer: ${err}`)
            })
            .then(() => this.amqpDepositCh.ack(msg))

          return
        }

        logger.info(`Deposit #${tradeOffer.id} sent to ${tradeOffer.steamId64}`)

        TradeOffers
          .get(tradeOffer.id)
          .update({
            bot: this.steamId,
            state: TRADE_STATE_SENT,
            offerId: parseInt(offer.id),
            tradeOfferUrl: `https://steamcommunity.com/tradeoffer/${offer.id}/`
          }, { returnChanges: true })
          .run(this.connection)
          .then(({ changes }) => {
            if(changes && changes.length) {
              this.notifyTradeOfferChange(changes[0].new_val, changes[0].old_val)
            }
          })
          .catch(err => {
            logger.error(`onDeposit() Cannot update trade offer: ${err}`)
          })
          .then(() => this.amqpDepositCh.ack(msg))
      })
    }.bind(this))

    .catch(err => {
      logger.error(`onDeposit() error: ${err}`)
      this.amqpDepositCh.ack(msg)
    })
  }

  declineTrade(steamId64, reason) {
    this.notify({
      method: 'onTradeOfferDeclined',
      params: {
        steamId64,
        reason
      }
    })
  }

  onLoggedOn(details) {
    // console.log(this.client.accountInfo)
    // co(function* () {
    //   const bot = {
    //     steamId64: this.steamId,
    //     tradeLink: this.tradeLink,
    //     display: this.display,
    //   }
    //
    //   const count = yield Bots
    //     .getAll(this.steamId, { index: 'steamId64'})
    //     .count()
    //     .run(this.connection)
    //
    //   if(count > 0) {
    //     return Bots
    //       .getAll(this.steamId, { index: 'steamId64'})
    //       .update(bot)
    //       .run(this.connection)
    //   }
    //
    //   Bots.insert(bot).run(this.connection)
    // }.bind(this))
  }

  withdraw(id) {
    return new Promise((resolve, reject) => {
      co(function* () {
        const tradeOffer = yield TradeOffers.get(id).run(this.connection)
        if(!tradeOffer) {
          logger.error(`withdraw() cannot find trade offer: ${id}`)
          return resolve()
        } else if(tradeOffer.verificationState === TRADE_VERIFICATION_STEP_PENDING) {
          return resolve()
        }

        const offer = this.manager.createOffer(tradeOffer.tradeLink)

        offer.setMessage(`${id}`)
        offer.addMyItems(tradeOffer.assetIds.map(assetid => ({
          assetid,
          appid: 730,
          contextid: 2
        })))

        offer.send((err, status) => {
          if(err) {

            BotItems
              .getAll(r.args(tradeOffer.assetIds), { index: 'assetId' })
              .update({
                state: BOT_ITEM_STATE_AVAILABLE
              })
              .run(this.connection)

            return reject(err)
          }

          TradeOffers
            .get(id)
            .update({
              offerId: parseInt(offer.id),
              state: TRADE_STATE_CONFIRM,
              hasError: false,
              errorResult: -1,
              tradeOfferUrl: `https://steamcommunity.com/tradeoffer/${offer.id}/`
            }, { returnChanges: true })
            .run(this.connection)
            .then(({ replaced, changes }) => {

              if(replaced > 0) {
                const tradeOffer = changes[0].new_val
                this.notifyTradeOfferChange(tradeOffer)
              }

            })

          if(status === 'pending') {
            return this.community.acceptConfirmationForObject(this.identitySecret, offer.id, (err) => {
              if(!err) {

                TradeOffers
                  .get(id)
                  .update({ state: TRADE_STATE_SENT }, { returnChanges: true })
                  .run(this.connection)
                  .then(({ replaced, changes, ...test }) => {
                    if(replaced > 0) {
                      const tradeOffer = changes[0].new_val
                      this.notifyTradeOfferChange(tradeOffer)
                    }
                  })

              }

              resolve()
  					})
          }

          resolve()
        })
      }.bind(this))

      .catch(reject)
    })
  }

  onMessage(msg) {
    const { fields: { exchange }, content } = msg

    switch(exchange) {

      case 'skne.withdraw':
        this
          .withdraw(content.toString())
          .then(() => {
            this.amqpCh.ack(msg)
          }, err => {
            logger.error(`onMessage() cannot send withdraw: ${err}`)

            TradeOffers
              .get(content.toString())
              .update({
                state: TRADE_STATE_DECLINED,
                hasError: true,
                error: err.message,
                errorResult: err.eresult || -1,
                maxRetries: 1,
                retryCount: r.row('retryCount').default(0).add(1),
              }, { returnChanges: true })
              .run(this.connection)
              .then(({ replaced, changes, ...test }) => {
                if(changes && changes.length) {

                  if(changes[0].new_val.retryCount < changes[0].new_val.maxRetries) {
                    setTimeout(() => this.amqpCh.nack(msg), 1000)
                  } else {

                    BotItems
                      .getAll(r.args(changes[0].new_val.assetIds), { index: 'assetId' })
                      .update({
                        state: BOT_ITEM_STATE_AVAILABLE
                      })
                      .run(this.connection)

                    this.amqpCh.ack(msg)
                  }

                  this.notifyTradeOfferChange(changes[0].new_val, changes[0].old_val)
                }
              })
          })

        break
      case 'skne.control':
        let { action, ...control } = JSON.parse(content.toString())

        if(action === 'cancelOffer') {
          this.manager.getOffer(control.offerId, (err, offer) => {
            if(!!err) {
              return this.amqpCh.ack(msg)
            }

            offer.decline(err => this.amqpCh.ack(msg))
          })
        } else if(action === 'confirmOffer') {
          this.manager.getOffer(control.offerId, (err, offer) => {
            if(!!err) {
              return this.amqpCh.ack(msg)
            }

            offer.accept(err => this.amqpCh.ack(msg))
          })
        }

        break
      default:
        this.amqpCh.ack(msg)
    }
  }

  onWebSession(session, cookies) {
    this.manager.setCookies(cookies, err => {
      if(err) {
        logger.error('Cannot set manager cookies', { err })
        process.exit(0)
        return
      }

      logger.info('Online')

      co(function* () {
        this.name = this.client.accountInfo.name
        this.steamId = this.client.steamID.getSteamID64()

        if(!this.steamId) {
          logger.error('could not get steam id!')
          return
        }

        this.tradeLink = yield new Promise((resolve, reject) => {
          this.manager.getOfferToken((err, token) => {
            if(err) {
              return reject(err)
            }

            resolve(`https://steamcommunity.com/tradeoffer/new/?partner=${this.client.steamID.accountid}&token=${token}`)
          })
        })

        const bot = {
          steamId64: this.steamId,
          tradeLink: this.tradeLink,
          display: this.display,
          username: this.username,
          name: this.name,
          storage: this.storage || false,
          groups: this.groups || []
        }

        const count = yield Bots
          .getAll(this.steamId, { index: 'steamId64'})
          .count()
          .run(this.connection)

        if(count > 0) {
          Bots
            .getAll(this.steamId, { index: 'steamId64'})
            .update(bot)
            .run(this.connection)
        } else {
          yield Bots.insert(bot).run(this.connection)
        }

        if(!this.storage && this.acceptDeposits || this.groups.indexOf('deposit') >= 0) {
          yield this.amqpDepositCh.consume('skne.deposit', this.onDeposit.bind(this))
        }

        yield this.amqpDepositCh.consume('skne.execute', this.onExecute.bind(this))

        this.controlQueue = yield this.amqpCh.assertQueue(`skne.bot.${this.steamId}`, { durable: true })
        yield this.amqpCh.bindQueue(this.controlQueue.queue, 'skne.control', this.steamId)
        yield this.amqpCh.bindQueue(this.controlQueue.queue, 'skne.withdraw', this.steamId)

        // if(this.groups.indexOf('opskins') >= 0) {
        //   logger.info('Accepting opskin virtual offers')
        //   yield this.amqpCh.bindQueue(this.controlQueue.queue, 'skne.virtual.withdraw', 'opskins')
        // }

        yield this.amqpCh.consume(this.controlQueue.queue, this.onMessage.bind(this))

        // if(process.argv.indexOf('save') >= 0) {
        this.insertInventory()
        // }

        this.checkOpenTrades()

        // Insert pending bot items
        this.insertPendingBotItems2().then(() => {
          setTimeout(function loop() {
            this.insertInventory()

            this.insertPendingBotItems2().then(() => {
              setTimeout(loop.bind(this), 30000)
            })

          }.bind(this), 30000)
        })

        if(this.storage && this.automaticStoreGroup.length) {
          const bots = yield Bots
            .getAll(r.args(_.map(config.bots, bot => bot.username)), { index: 'username' })
            .filter(r.row('groups').default([]).contains(group =>
              r.expr(this.automaticStoreGroup).contains(group)
            ))
            .coerceTo('array')
            .run(this.connection)

          this.startAutomaticStore(_.pluck(bots, 'steamId64'))
        }

      }.bind(this))

      .catch(err => logger.error(err))
    })

    this.community.setCookies(cookies)
    this.pollConfirmations()

    // this.community.startConfirmationChecker(600000, this.identitySecret)
  }

  startAutomaticStore(botIds) {
    eachSeries(botIds, (botId, done) => {
      co(function*() {

        const itemCount = yield BotItems.getAll(this.steamId, { index: 'bot' }).count().run(this.connection)
        if(itemCount >= 950) {
          // logger.info('Bot is near full, cannot accept new items for storage')
          done()
        }

        const offers = yield TradeOffers
          .getAll([ botId, TRADE_TYPE_DEPOSIT, TRADE_STATE_ACCEPTED ], [ botId, TRADE_TYPE_STORAGE, TRADE_STATE_ACCEPTED ], { index: 'botTypeState' })
          .filter(r.row('bot').ne(this.steamId).and(r.row('storageState').default(TRADE_ITEM_STATE_PENDING).eq(TRADE_ITEM_STATE_PENDING)).and(r.row('createdAt').ge(new Date(Date.now() - 60000 * 10))))
          .coerceTo('array')
          .run(this.connection)

        for(let offer of offers) {

          // Items need to still exist
          let existingCount = yield BotItems
            .getAll(r.args(offer.assetIds), { index: 'assetId' })
            .count()
            .run(this.connection)

          if(existingCount !== offer.assetIds.length) {

            if(Date.now() >= offer.createdAt.getTime() + 60000) {
              yield TradeOffers.get(offer.id).update({
                storageState: TRADE_ITEM_STATE_INSERTED
              }).run(this.connection)
            }

            continue
          }

          const { replaced } = yield TradeOffers.get(offer.id).update({
            storageState: TRADE_ITEM_STATE_INSERTED
          }, { returnChanges: true }).run(this.connection)

          if(replaced === 0) {
            continue
          }

          const tradeOffer = {
            steamId64: this.steamId,
            tradeLink: this.tradeLink,
            notifyUrl: offer.notifyUrl || null,
            assetIds: offer.assetIds,
            subtotal: offer.subtotal,
            itemNames: offer.itemNames,
            bot: offer.bot,

            securityToken: offer.securityToken || '',

            createdAt: new Date(),
            meta: {
              ...offer.meta,
              originalOffer: offer.id
            },
            type: TRADE_TYPE_STORAGE,
            state: TRADE_STATE_QUEUED,

            botName: offer.botName || ''
          }

          const { generated_keys } = yield TradeOffers.insert(tradeOffer, { returnChanges: true }).run(this.connection)
          this.amqpCh.publish('skne.withdraw', offer.bot, new Buffer(generated_keys[0]), { persistent: true })
        }

        done()
      }.bind(this))

      .catch(done)
    }, err => {
      if(err) {
        logger.error(`startAutomaticStore() ${err}`)
      }


      setTimeout(() => this.startAutomaticStore(botIds), 10000)
    })
  }

  pollConfirmations() {
    co(function* () {
      const pending = yield TradeOffers.getAll(TRADE_STATE_CONFIRM, { index: 'state' }).coerceTo('array').run(this.connection)
      if(pending.length <= 0) {
        return setTimeout(this.pollConfirmations.bind(this), 5000)
      }

      eachSeries(pending, (offer, done) => {
        if(offer.type !== TRADE_TYPE_WITHDRAW) {
          try {
            this.community.checkConfirmations()
          } catch(e) {
          }

          done()
        }

        this.community.acceptConfirmationForObject(this.identitySecret, offer.offerId, (err) => {
          if(err) {
            logger.error(`addNewTradeOffer() cannot confirm accepted offer: ${err}`)
          } else {
            TradeOffers
              .get(offer.id)
              .update({ state: TRADE_STATE_SENT }, { returnChanges: true })
              .run(this.connection)
              .then(({ replaced, changes, ...test }) => {
                if(replaced > 0) {
                  const tradeOffer = changes[0].new_val
                  this.notifyTradeOfferChange(tradeOffer)
                }
              })
          }

          done()
        })

      }, () => setTimeout(this.pollConfirmations.bind(this), 60000))
      // this.community.checkConfirmations()
      // setTimeout(this.pollConfirmations.bind(this), 5000)
    }.bind(this))

    .catch(err => {
      setTimeout(this.pollConfirmations.bind(this), 5000)
    })
  }

  insertInventory() {

    return co(function* () {
      const inventory = yield new Promise((resolve, reject) => {
        this.manager.getInventoryContents(730, 2, true, (err, items) => {
          if(err) {
            return reject(err.message)
          }

          resolve(items)
        })
      })

      const stored = yield BotItems.getAll(this.steamId, { index: 'bot' }).coerceTo('array').run(this.connection)

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

      const botItems = added.map(item => ({
        createdAt: new Date(),
        state: BOT_ITEM_STATE_AVAILABLE,
        bot: this.steamId,
        assetId: parseInt(item.id),
        name: item.market_hash_name,
        type: item.type,
        tags: item.tags,
        originalOwner: this.steamId,
      }))

      if(botItems.length > 0) {
        console.log(added.length + ' added')
        yield BotItems.insert(botItems).run(this.connection)
      }

      if(removed.length > 0) {
        console.log(removed.length + ' removed')
        yield BotItems.getAll(r.args(removed.map(i => i.id))).delete().run(this.connection)
      }

    }.bind(this))

    .catch(logger.error)
  }

  // handleTradeOffer
  handleTradeOffer(trade) {
    const declinedStates = [
      ETradeOfferState.Declined,
      ETradeOfferState.Canceled,
      ETradeOfferState.Invalid,
      ETradeOfferState.InvalidItems,
      ETradeOfferState.CanceledBySecondFactor,
      ETradeOfferState.Countered,
    ]

    return new Promise((resolve, reject) => {
      this.manager.getOffer(trade.offerId, (err, offer) => {
        if(err) {
          return resolve()
        }

        if(offer.state === ETradeOfferState.InEscrow) {
          return resolve()
        } else if(declinedStates.indexOf(offer.state) >= 0) {
          return TradeOffers
            .getAll(parseInt(offer.id), { index: 'offerId' })
            .update({ state: TRADE_STATE_DECLINED }, { returnChanges: true })
            .run(this.connection)
            .then(({ replaced, changes, ...test }) => {
              if(changes && changes.length) {
                this.notifyTradeOfferChange(changes[0].new_val, changes[0].old_val)
              }
            })
        }

        if(offer.state !== ETradeOfferState.Accepted) {

          // Expired incoming trade
          if(trade.type === TRADE_TYPE_INCOMING && trade.expiration < new Date()) {
            logger.info(`Incoming trade ${trade.offerId} has expired`)

            return this.retryFn(offer.decline.bind(offer), 3, err => {
              return resolve()
            })
          } else if(trade.type === TRADE_TYPE_INCOMING && trade.expiration > new Date()) {
            schedule.scheduleJob(trade.expiration, this.onOfferExpired.bind(this, trade.offerId))
          }
        }

        if(trade.state === TRADE_STATE_DECLINED || declinedStates.indexOf(offer.state) >= 0) {
          logger.info(`Trade ${offer.id} has been declined/canceled`, {
            state: offer.state
          })

          if(trade.type === TRADE_TYPE_INCOMING) {
            TradeOffers.get(trade.id).delete().run(this.connection)
            return resolve()
          }
        }

        resolve()
      })
    })
  }

  onOfferExpired(id) {
    this.manager.getOffer(id, (err, offer) => {
      if(!!err) {
        logger.error(`onOfferExpired() cannot get expired offer: ${err}`)
        setTimeout(() => onOfferExpired(id), 1500)
        return
      }

      if(offer.state === ETradeOfferState.Active) {
        offer.decline(err => {
          if(!!err) {
            return logger.error(`onOfferExpired() cannot decline expired offer: ${err}`)
          }
        })
      }
    })
  }

  // checkOpenTrades
  checkOpenTrades() {
    return new Promise((resolve, reject) => {

      const today = new Date()
      today.setHours(0, 0, 0, 0)

      this.manager.getOffers(EOfferFilter.ActiveOnly, today, (err, sent, received) => {
        if(err) {
          return reject(`Could not get open trades: ${err}`)
        }

        eachSeries(received, (offer, done) => {
          if(offer.state !== ETradeOfferState.Active) {
            return done()
          }

          return this.addNewTradeOffer(offer)
            .then(() => done())
            .catch(done)
        }, (err) => {
          if(err) {
            return reject(err)
          }

          resolve()
        })
      })
    })

    // Check the trades in the database
    .then(new Promise((resolve, reject) => {
      return co(function* () {
        const openTrades = yield TradeOffers
          .getAll(this.steamId, { index: 'bot' })
          .filter(r.row('state').eq(TRADE_STATE_SENT))
          .coerceTo('array')
          .run(this.connection)

        eachSeries(openTrades, (trade, done) => {
          return this.handleTradeOffer(trade)
            .then(() => done())
            .catch(done)
        }, (err) => {
          if(err) {
            return reject(err)
          }

          resolve()
        })

      }.bind(this))
    }))
  }

  // notify
  notify(rpcCall) {
    const { servers } = config

    this.notifyServers.forEach(server =>
      this.amqpCh.sendToQueue('skne.notify', new Buffer(JSON.stringify({
        ...rpcCall,
        server: servers[server]
      })), { persistent: true })
    )
  }

  publishNotification(params) {
    const servers = _.values(config.servers)

    if(!!params.notifyUrl) {
      servers.push(params.notifyUrl)
    }

    _.uniq(servers).forEach(server => {
      this.amqpCh.sendToQueue('skne.notify', new Buffer(JSON.stringify({
        server,
        params,
        method: 'offer.change'
      })))
    })
  }

  // notifyTradeOfferChange
  notifyTradeOfferChange(offer, oldOffer) {
    if(offer.type === 'STORAGE') {
      return
    }

    // Virtual Deposits
    if(!!offer.meta.pendingOfferId) {
      console.log('update to ' + offer.state)

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

      console.log(update)

      if(Object.keys(update).length > 0) {
        VirtualOffers
          .get(offer.meta.pendingOfferId)
          .update(update, { returnChanges: true })
          .run(this.connection)
          .then(({ replaced, changes }) => {
            if(replaced > 0) {
              this.publishNotification(changes[0].new_val)
            }
          })
      }
    }

    const servers = []

    if(!!this.notifyServers) {
      this.notifyServers.forEach(server => servers.push(config.servers[server]))
    }

    if(!!offer.notifyUrl && servers.indexOf(offer.notifyUrl) < 0) {
      servers.push(offer.notifyUrl)
    }

    servers.forEach(server => {
      this.amqpCh.sendToQueue('skne.notify', new Buffer(JSON.stringify({
        method: 'trade.OnTradeOfferStateChange',
        server: server,
        params: offer
      })))
    })
  }

  sleep(ms) {
    return new Promise(resolve => {
      setTimeout(() => resolve(), ms)
    })
  }
  // addNewTradeOffer
  addNewTradeOffer(offer) {
    const { id, itemsToReceive, itemsToGive } = offer
    return co(function* () {
      let fromOPSkins = false

      if(!this.storage) {
        const exists = yield TradeOffers.getAll(parseInt(offer.id), { index: 'offerId' }).count().run(this.connection)
        if(exists > 0) {
          return Promise.resolve()
        }
      }

      if(!this.storage && !this.acceptIncomingTrades) {
        return new Promise((resolve, reject) =>
          this.retryFn(offer.decline.bind(offer), 3, err =>
            err ? Promise.reject(err) : resolve()
          )
        )
      }

      if(this.storage) {
        let whitelist       = config.storageWhitelist || []
        const botSteamIds   = yield Bots.map(b => b('steamId64')).coerceTo('array').run(this.connection)
        whitelist           = whitelist.concat(botSteamIds)

        const forceAccept = yield co(function* () {
          if(whitelist.indexOf(offer.partner.getSteamID64()) >= 0) {
            return true
          }

          if(this.groups && this.groups.indexOf('opskins') >= 0) {

            // Wait for opskins?
            // TODO: Come up with a better solution
            for(let i  = 0; i < 10; i++) {
              let existsCount = yield VirtualOffers
                .getAll(parseInt(id), { index: 'incomingOfferIds' })
                .count()
                .run(this.connection)

              if(existsCount > 0) {
                return true
              }

              yield this.sleep(800)
            }

            // Resort to just looking if it's an opskins bot
            return yield new Promise((resolve, reject) => {
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

          return false
        }.bind(this))

        if(forceAccept || whitelist.indexOf(offer.partner.getSteamID64()) >= 0) {
          const validItems = yield new Promise((resolve, reject) =>
            mapSeries(itemsToReceive, (item, done) => {
              if(item.appid !== 730) {
                return done(item.market_hash_name + ' is not a valid item')
              }

              co(function* () {
                const descriptions = yield Items
                  .getAll(item.market_hash_name, { index: 'name' })
                  .coerceTo('array')
                  .run(this.connection)

                if(!descriptions.length) {
                  return done('Could not get price for item: ' + item.market_hash_name)
                }

                const { icon, tokens, wear, price } = descriptions[0]

                done(null, {
                  wear: wear || -1,

                  id: item.id,
                  tokens: tokens,
                  name: item.market_hash_name,
                  icon: icon,
                  price: price

                })
              }.bind(this)).catch(console.log)

            }, (err, items) => {
              if(err) {
                this.declineTrade(offer.partner.getSteamID64(), err)
                return reject(err)
              }

              resolve(items)
            })
          )

          const total = validItems.reduce((t, i) => t + i.tokens, 0)
          const tradeOffer = {
            offerId: parseInt(id),
            type: TRADE_TYPE_STORAGE,
            state: TRADE_STATE_SENT,
            steamId64: offer.partner.getSteamID64(),
            createdAt: new Date(),
            bot: this.steamId,
            assetIds: itemsToReceive.map(i => parseInt(i.assetid)),
            itemNames: itemsToReceive.map(i => i.market_hash_name),
            giveAssetIds: itemsToGive.map(i => parseInt(i.assetid)),
            giveItemNames: itemsToGive.map(i => i.market_hash_name),
            items: validItems,
            tokens: total,
            subtotal: total,
            price: total / config.tokenMultiplier,
            expiration: new Date(Date.now() + 60000),
            retries: 0
          }

          const count = yield TradeOffers
            .getAll(id, { index: 'offerId'})
            .count()
            .run(this.connection)

          if(count > 0) {
            return TradeOffers
              .getAll(id, { index: 'offerId'})
              .update(tradeOffer)
              .run(this.connection)
          }

          //
          // schedule.scheduleJob(tradeOffer.expiration, this.onOfferExpired.bind(this, parseInt(id)))
          //
          const { generated_keys } = yield TradeOffers.insert(tradeOffer).run(this.connection)
          tradeOffer.id = generated_keys[0]
          this.notifyTradeOfferChange(tradeOffer)

          offer.accept((err, status) => {
            if(err) {
              logger.error(`addNewTradeOffer() cannot accept offer: ${err}`)
            }

            if(status === 'pending') {
              this.community.acceptConfirmationForObject(this.identitySecret, offer.id, (err) => {
                if(err) {
                  logger.error(`addNewTradeOffer() cannot confirm accepted offer: ${err}`)
                }
              })
            }
          })
        } else {
          this.declineTrade(offer.partner.getSteamID64(), 'Not authorized')
          return new Promise((resolve, reject) =>
            this.retryFn(offer.decline.bind(offer), 3, err =>
              err ? Promise.reject(err) : resolve()
            )
          )
        }

        return
      }

      // Decline:
      // - People asking for items
      // - People with no items
      // - People with items more than 10
      if(itemsToGive.length > 0 || itemsToReceive.length === 0 || itemsToReceive.length > this.maxItemsDepositAmount) {
        this.declineTrade(offer.partner.getSteamID64(), 'Invalid amount of items received')
        return new Promise((resolve, reject) =>
          this.retryFn(offer.decline.bind(offer), 3, err =>
            err ? Promise.reject(err) : resolve()
          )
        )
      }

      // Check if maximum trades open has been reached
      const openIncomingTrades = yield TradeOffers
        .getAll([offer.partner.getSteamID64(), TRADE_TYPE_INCOMING], { index: 'steamId64Type'})
        .filter({
          bot: this.steamId,
          state: TRADE_STATE_SENT
        })
        .count()
        .run(this.connection)

      if(openIncomingTrades >= this.maxOpenTrades) {
        this.declineTrade(offer.partner.getSteamID64(), `Max open trade limit of ${this.maxOpenTrades} reached`)
        return new Promise((resolve, reject) =>
          this.retryFn(offer.decline.bind(offer), 3, err =>
            err ? Promise.reject(err) : resolve()
          )
        )
      }

      const validItems = yield new Promise((resolve, reject) =>
        mapSeries(itemsToReceive, (item, done) => {
          if(item.appid !== 730) {
            return done(item.market_hash_name + ' is not a valid item')
          } else if(item.category === 'case' || item.category === 'sticker' || item.souvenir) {
            return done(`${item.market_hash_name} not accepted`)
          }

          co(function* () {
            const descriptions = yield Items
              .getAll(item.market_hash_name, { index: 'name' })
              .coerceTo('array')
              .run(this.connection)

            if(!descriptions.length) {
              return done('Could not get price for item: ' + item.market_hash_name)
            }

            const { icon, tokens, wear, price } = descriptions[0]

            done(null, {
              wear: wear || -1,

              id: item.id,
              tokens: tokens,
              name: item.market_hash_name,
              icon: icon,
              price: price

            })
          }.bind(this)).catch(console.log)

        }, (err, items) => {
          if(err) {
            this.declineTrade(offer.partner.getSteamID64(), err)
            return reject(err)
          }

          resolve(items)
        })
      )

      const total = validItems.reduce((t, i) => t + i.tokens, 0)
      if(total < this.minDepositAmount) {
        this.declineTrade(offer.partner.getSteamID64(), `Deposit does not meet minimum deposit`)
        return new Promise((resolve, reject) =>
          this.retryFn(offer.decline.bind(offer), 3, err =>
            err ? Promise.reject(err) : resolve()
          )
        )
      }

      const tradeOffer = {
        offerId: parseInt(id),
        type: TRADE_TYPE_INCOMING,
        state: TRADE_STATE_SENT,
        steamId64: offer.partner.getSteamID64(),
        createdAt: new Date(),
        bot: this.steamId,
        assetIds: itemsToReceive.map(i => parseInt(i.assetid)),
        itemNames: itemsToReceive.map(i => i.market_hash_name),
        items: validItems,
        tokens: total,
        subtotal: total,
        price: total / config.tokenMultiplier,
        expiration: new Date(Date.now() + 60000),
        retries: 0,

      }

      const count = yield TradeOffers
        .getAll(id, { index: 'offerId'})
        .count()
        .run(this.connection)

      if(count > 0) {
        return TradeOffers
          .getAll(id, { index: 'offerId'})
          .update(tradeOffer)
          .run(this.connection)
      }

      schedule.scheduleJob(tradeOffer.expiration, this.onOfferExpired.bind(this, parseInt(id)))

      const { generated_keys } = yield TradeOffers.insert(tradeOffer).run(this.connection)
      tradeOffer.id = generated_keys[0]
      this.notifyTradeOfferChange(tradeOffer)

      return tradeOffer
    }.bind(this))

    .catch(console.log)
  }

  // onNewTradeOffer
  onNewTradeOffer(offer) {
    logger.info(`Incoming trade offer ${offer.id}`)
    this.addNewTradeOffer(offer)
  }

  // onOfferChanged
  onOfferChanged(offer, oldState) {
    const declinedStates = [
      ETradeOfferState.Declined,
      ETradeOfferState.Canceled,
      ETradeOfferState.Invalid,
      ETradeOfferState.InvalidItems,
      ETradeOfferState.CanceledBySecondFactor,
      ETradeOfferState.Countered,
    ]

    if(offer.state !== oldState) {
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

      if(tradeOfferState) {
        const update = {
          state: tradeOfferState,
          meta: r.row('meta').default({})
        }

        if(offer.state === ETradeOfferState.Accepted) {
          update.itemState = TRADE_ITEM_STATE_PENDING
        }

        TradeOffers
          .getAll(parseInt(offer.id), { index: 'offerId' })
          .update(update, { returnChanges: true })
          .run(this.connection)
          .then(({ replaced, changes }) => {
            if(replaced > 0) {
              const tradeOffer = changes[0].new_val

              if(offer.state === ETradeOfferState.Accepted) {
                this.redisClient.del(`inventory:${changes[0].new_val.steamId64}`)

                if(changes[0].new_val.type === TRADE_TYPE_WITHDRAW) {
                  const assetIDs = offer.itemsToGive

                  BotItems
                    .getAll(r.args(changes[0].new_val.assetIds), { index: 'assetId' })
                    .delete()
                    .run(this.connection)

                  this.notifyTradeOfferChange(changes[0].new_val, changes[0].old_val)
                } else {
                  this.insertPendingBotItems(changes[0].new_val.id)
                }
              } else if(offer.state === ETradeOfferState.Declined) {
                if(changes[0].new_val.type === TRADE_TYPE_WITHDRAW) {
                  logger.error(`onOfferChanged() trade ${offer.id} declined, refunding offer`)
                  const assetIDs = offer.itemsToGive

                  BotItems
                    .getAll(r.args(changes[0].new_val.assetIds), { index: 'assetId' })
                    .update({
                      state: BOT_ITEM_STATE_AVAILABLE
                    })
                    .run(this.connection)
                }
              }

              if(offer.state !== ETradeOfferState.Accepted) {
                this.notifyTradeOfferChange(changes[0].new_val, changes[0].old_val)
              }
            }
          })

          .catch(console.log)
      }
    }
  }

  insertPendingBotItems(tradeOfferId) {
    return co(function* () {
      const pending = yield TradeOffers
        .getAll(tradeOfferId)
        .filter({ itemState: TRADE_ITEM_STATE_PENDING })
        .coerceTo('array')
        .run(this.connection)

      if(!pending.length) {
        return Promise.resolve()
      }

      return new Promise((resolve, reject) => {
        eachSeries(pending, (tradeOffer, done) => {
          if(tradeOffer.assetIds.length) {
            logger.info(`Inserting ${tradeOffer.assetIds.length} bot items from offer ${tradeOffer.id}`)
          }

          this.manager.getOffer(tradeOffer.offerId, (err, offer) => {
            if(err) {
              logger.error(`Could not get offer ${tradeOffer.offerId}: ${err}`)
              return done()
            }

            if(tradeOffer.type === TRADE_TYPE_STORAGE && offer.itemsToGive.length) {
              logger.info(`Removing ${offer.itemsToGive.length} bot items from offer ${tradeOffer.id}`)
              BotItems.getAll(r.args(offer.itemsToGive.map(i => parseInt(i.assetid))), { index: 'assetId' }).delete().run(this.connection)
            }

            if(offer.itemsToReceive.length) {
              offer.getReceivedItems((err, items) => {
                if(err) {
                  logger.error(`Could not get offer items ${tradeOffer.offerId}: ${err}`)
                  return done()
                } else if(!items.length) {
                  logger.error('Empty items returned')
                  return done()
                }

                const botItems = items.map(item => ({
                  createdAt: new Date(),
                  state: tradeOffer.type === TRADE_TYPE_INCOMING ? BOT_ITEM_STATE_IN_USE : BOT_ITEM_STATE_AVAILABLE,
                  bot: this.steamId,
                  assetId: parseInt(item.id),
                  name: item.market_hash_name,
                  type: item.type,
                  tags: item.tags,
                  offerId: parseInt(offer.id),
                  tradeOfferId: tradeOffer.id,
                  originalOwner: tradeOffer.steamId64,
                }))

                mapSeries(items, (item, done) => {

                  co(function* () {
                    const descriptions = yield Items
                      .getAll(item.market_hash_name, { index: 'name' })
                      .coerceTo('array')
                      .run(this.connection)

                    if(!descriptions.length) {
                      return done('Could not get price for item: ' + item.market_hash_name)
                    }

                    const { icon, tokens, wear, price } = descriptions[0]

                    done(null, {
                      wear: wear || -1,

                      id: parseInt(item.id),
                      tokens: tokens,
                      name: item.market_hash_name,
                      icon: icon,
                      price: price

                    })
                  }.bind(this)).catch(console.log)

                }, (err, items) => {
                  mapSeries(botItems, (item, done) => {
                    co(function* () {
                      const existing = yield BotItems
                        .getAll(item.assetId, { index: 'assetId' })
                        .pluck('id')
                        .coerceTo('array')
                        .run(this.connection)

                      if(existing.length) {
                        return done(null, existing[0].id)
                      }

                      const result = yield BotItems.insert(item).run(this.connection)
                      done(null, result.generated_keys[0])
                    }.bind(this))

                    .catch(done)
                  }, (err, botItemIds) => {
                    if(err) {
                      logger.error(err)
                      return done()
                    }

                    co(function* () {
                      const botItemsIdsRow = r.row('botItemIds').default([])
                      const tradeItemIdsRow = r.row('tradeItemIds').default([])
                      const newBotItemsIdRow = botItemsIdsRow.add(botItemIds)

                      if(this.groups.indexOf('opskins') >= 0) {
                        let updateResult = yield VirtualOffers
                          .getAll(tradeOffer.offerId , { index: 'incomingOfferIds'})
                          .update({
                            botItemIds: newBotItemsIdRow,
                            tradeItemIds: tradeItemIdsRow.append(tradeOffer.id),
                            assetIds: r.row('assetIds').default([]).add(_.pluck(botItems, 'assetId'))
                          }, {
                            returnChanges: true
                          })
                          .run(this.connection)

                        // if(updateResult.replaced > 0) {
                        //   const virtualOffer = updateResult.changes[0].new_val
                        //
                        //   if(virtualOffer.assetIds.length === virtualOffer.itemNames.length) {
                        //     logger.info(`OPSKINS #${tradeOffer.offerId} is ready`)
                        //
                        //     const newTradeOffer = {
                        //       createdAt: new Date(),
                        //       type: TRADE_TYPE_WITHDRAW,
                        //       state: TRADE_STATE_QUEUED,
                        //       steamId64: virtualOffer.steamId,
                        //       tradeLink: virtualOffer.tradeUrl,
                        //       notifyUrl: virtualOffer.notifyUrl,
                        //       assetIds: virtualOffer.assetIds,
                        //       subtotal: virtualOffer.subtotal,
                        //       itemNames: virtualOffer.itemNames,
                        //       bot: this.steamId,
                        //
                        //       meta: {
                        //         ...virtualOffer.meta,
                        //         virtualOfferId: virtualOffer.id
                        //       }
                        //     }
                        //
                        //     const { generated_keys: [ newTradeOfferId ] } = yield TradeOffers.insert(newTradeOffer, { returnChanges: true }).run(this.connection)
                        //     newTradeOffer.id = newTradeOfferId
                        //
                        //     yield VirtualOffers.get(virtualOffer.id).update({
                        //       tradeOfferId: newTradeOfferId
                        //     }).run(this.connection)
                        //
                        //     this.amqpCh.publish('skne.withdraw', newTradeOffer.bot, new Buffer(newTradeOfferId), { persistent: true })
                        //   }
                        // }
                      }

                      yield TradeOffers
                        .get(tradeOffer.id)
                        .update({
                          items,
                          botItemIds,
                          assetIds: items.map(i => i.id),
                          itemState: TRADE_ITEM_STATE_INSERTED
                        }, { returnChanges: true })
                        .run(this.connection)
                        .then(({ replaced, changes }) => {
                          if(replaced > 0) {
                            this.notifyTradeOfferChange(changes[0].new_val, changes[0].old_val)
                          }

                          done()
                        })
                    }.bind(this))

                    .catch(err => {
                      logger.error(err)
                      done()
                    })
                  })
                })
              })
            } else {
              done()
            }
          })

        }, () => resolve())
      })
    }.bind(this))
  }

  insertPendingBotItems2() {
    return co(function* () {
      const pending = yield TradeOffers
        .getAll([this.steamId, TRADE_ITEM_STATE_PENDING, TRADE_TYPE_DEPOSIT], { index: 'botItemStateType' })
        .filter({ state: TRADE_STATE_ACCEPTED })
        .coerceTo('array')
        .run(this.connection)

      if(!pending.length) {
        return Promise.resolve()
      }

      return new Promise((resolve, reject) => {
        eachSeries(pending, (tradeOffer, done) => {
          // logger.info(`Inserting ${tradeOffer.assetIds.length} bot items from offer ${tradeOffer.id}`)
          this
            .insertPendingBotItems(tradeOffer.id)
            .then(() => done())
            .catch(err => {
              logger.error(`insertPendingBotItems2() error: ${err}`)
              done()
            })
        }, (err) => {
          resolve()
        })
      })
    }.bind(this))
  }

  retryFn(fn, attempts, cb) {
    if(attempts <= 0) {
      return cb('Max attempts reached')
    }

    fn(function(err) {
      if(err) {
        this.retryFn(fn, attempts - 1, cb)
        return
      }

      cb.apply(null, arguments)
    }.bind(this))
  }

  // onVirtualWithdraw(message) {
  //   const id = message.content.toString()
  //
  //   co(function* () {
  //     const offer = yield VirtualOffers.get(id).run(this.connection)
  //     if(!offer) {
  //       return this.amqpCh.ack(msg)
  //     }
  //
  //
  //
  //   }.bind(this))
  //
  //   .catch(err => {
  //     logger.error('onVirtualWithdraw()', {
  //       error: err.message || err
  //     })
  //
  //     // this.amqpCh.nack(msg, false, false)
  //   })
  // }

}

// canAcceptItem
export function canAcceptItem({ name, category, souvenir, tokens, statTrak, type, price, blocked }) {
  if(blocked) {
    return false
  }

  const bannedTypes = ['Base Grade Container']
  if(bannedTypes.indexOf(type) >= 0) {
    return false
  } else if(type.indexOf('Collectible') >= 0) {
    return false
  }

  // No StatTrak items
  // if((typeof config.block.stKnives === 'undefined' || config.block.stKnives) && category === CATEGORY_MELEE && statTrak) {
    // return false
  if(category === CATEGORY_STICKER) {
    return false
  } else if(category === CATEGORY_CASE) {
    return false
  }

  return !souvenir && price >= config.minimumDeposit && config.blockedItems.indexOf(name) < 0
}
