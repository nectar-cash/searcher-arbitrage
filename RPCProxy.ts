import { ethers } from './deps.ts'
import { config } from './deps.ts'
import SturdyWebSocket from './SturdyWebsocket.ts'

const env = config()

const rpcUrl = `wss://${env['CHAIN_NAME']}.infura.io/ws/v3/${env['INFURA_KEY']}`
const ws = new SturdyWebSocket(rpcUrl)
// const ws = new WebSocket(rpcUrl)

const rpc = new ethers.providers.WebSocketProvider(ws, {
  name: env['CHAIN_NAME'],
  chainId: parseInt(env['CHAIN_ID']),
})

setTimeout(() => {
  ws.reconnect()
  console.log('reconnecting websockets')
}, 60 * 60 * 1000)

export default rpc
