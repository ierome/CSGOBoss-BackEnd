
import { publishNotification, amqpChannel, amqpNextRpcAckId, registerAmqpRpcCb } from '../../lib/amqp'

function* execute([ { method, params } ]) {
  const id = amqpNextRpcAckId()

  const promise = new Promise((resolve, reject) => {
    registerAmqpRpcCb(id, message => {
      resolve(JSON.parse(message.content.toString()))
    })
  })

  amqpChannel().sendToQueue('skne.execute', new Buffer(JSON.stringify({
    method,
    params
  })), {
    correlationId: id,
    replyTo: 'skne'
  })

  return promise
}

export default {
  execute
}
