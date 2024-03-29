import reportAddressEvent from './EventReporter.ts'
import { serve } from './deps.ts'
import { ethers } from './deps.ts'
import { config } from './deps.ts'

import { PayloadAny, PayloadAuctionBidRecipient, PayloadRPCNewAuction, PayloadSearcherBid } from './deps.ts'
import { METHOD_AUCTION_BID_RECIPIENT, METHOD_RPC_NEW_AUCTION, METHOD_SEARCHER_BID } from './deps.ts'

import { processTransaction } from './SearcherArbitrage.ts'

const env = { ...config(), ...Deno.env.toObject() }

let bidRecipient = '0x0'

const registrationAddress = new ethers.Wallet(env['SELF_PRIVATE_KEY']!).address
// console.log(registrationAddress)

const auctionConnection = new WebSocket(`${env['AUCTION_URL']}/searcher?address=${registrationAddress}`)

auctionConnection.onmessage = async (m) => {
  try {
    const body: PayloadAny = JSON.parse(m.data)
    const { method, data } = body
    console.log('Auction message:', method)
    if (method === METHOD_RPC_NEW_AUCTION) {
      const { hash, tx, options } = data as PayloadRPCNewAuction['data']
      console.log('Got new tx', hash, 'with options', options)
      reportAddressEvent(tx.from!, `Searcher: Received tx ${hash} to evaluate`)
      const t = performance.now()
      // console.log('Fees for', bidRecipient)
      const bundle = await processTransaction(hash, tx, bidRecipient)
      const duration = performance.now() - t
      console.log('Time in ms to build bundle', duration)
      if (bundle) {
        const auctionResultPayload: PayloadSearcherBid = {
          method: METHOD_SEARCHER_BID,
          data: { bundle },
        }
        auctionConnection.send(JSON.stringify(auctionResultPayload))
        reportAddressEvent(tx.from!, `Searcher: Sent the bid for tx ${hash}`)
      }
    } else if (method === METHOD_AUCTION_BID_RECIPIENT) {
      const { address } = data as PayloadAuctionBidRecipient['data']
      bidRecipient = address
      console.log('Recorded new bid recipient:', bidRecipient)
    }
  } catch (e) {
    console.log(e)
    console.error('cannot parse message', m.data)
  }
}
auctionConnection.onopen = () => {
  console.log('Connected to auction', env['AUCTION_URL'])
}

// This is just to keep ws connection alive
await serve(() => new Response('searcher-arbitrage', { status: 200 }), { port: 11018 })
