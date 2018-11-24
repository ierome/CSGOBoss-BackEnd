
import _ from 'underscore'
import config from 'config'
import amqplib from 'amqplib'

let _connection = null
let _channel = null

export function amqpConnect() {
  return amqplib.connect(config.amqp).then(connection => {
    _connection = connection
    return connection.createChannel()
  }).then(channel => {
    _channel = channel
    return _connection
  })
}

export function amqpCh() {
  return _channel
}

export function amqpConnection() {
  return _connection
}

const _rpcCallbacks = {}
let _rpcAckId = 0

export function amqpNextRpcAckId() {
  return (++_rpcAckId).toString()
}

export function registerAmqpRpcCb(id, fn) {
  _rpcCallbacks[id] = fn
}

export function callAmqpRpcCb(id, message) {
  const fn = _rpcCallbacks[id]
  if(!fn) {
    return
  }

  fn(message)
  delete _rpcCallbacks[id]
}

export function amqpChannel() {
  // TODO: Move amqp connection to this module, this is temp.
  return tmp_amqpCh()
}

export function publishNotification(params, method = 'offer.change') {
  const servers = _.values(config.servers)

  if(!!params.notifyUrl) {
    servers.push(params.notifyUrl)
  }

  _.uniq(servers).forEach(server => {
    amqpChannel().sendToQueue('skne.notify', new Buffer(JSON.stringify({
      server,
      params,
      method
    })))
  })
}
