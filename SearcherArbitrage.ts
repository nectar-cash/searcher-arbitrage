import { ethers, BigNumber } from './deps.ts'
import { Percent, Token, CurrencyAmount } from './deps.ts'
import { TradeType } from './deps.ts'
import { Router } from './deps.ts'
import { config } from './deps.ts'
import { TransactionBundle, TransactionIntent } from './deps.ts'

import IUniswapV3FactoryABI from './abis/IUniswapV3Factory.json' assert { type: 'json' }
import IUniswapV2RouterABI from './abis/IUniswapV2Router02.json' assert { type: 'json' }

import { decodeRaw, decodeUniversalRaw } from './utils/decode.ts'
import { getUniswapV3TradeParams, getUniswapUniversalTradeParams } from './utils/getUniswapV3TradeParams.ts'

import rpc from './RPCProxy.ts'
import reportAddressEvent from './EventReporter.ts'

export interface Multicall {
  deadline: BigNumber
  calls: {
    signature: string
    parameters: ethers.utils.Result
  }[][]
}

const env = config()
// console.log('network info', rpc.network)

const WETH = new Token(parseInt(env['CHAIN_ID']), env['WETH_CONTRACT'], 18, 'WETH')
const SwapToken = new Token(parseInt(env['CHAIN_ID']), env['TOKEN_CONTRACT'], 18, 'NTT')

const wallet = new ethers.Wallet(env['SELF_PRIVATE_KEY'], rpc)

const uniV3Factory = new ethers.Contract(env['UNISWAP_V3_FACTORY'], IUniswapV3FactoryABI, rpc)
const uniV3AlphaRouter = new Router.AlphaRouter({ chainId: parseInt(env['CHAIN_ID']), provider: rpc })
const sushiRouter = new ethers.Contract(env['SUSHI_V2_ROUTER'], IUniswapV2RouterABI, wallet)
// console.log('sushi network info', await sushiRouter.signer.provider?.getNetwork())

export function processTransaction(hash: string, tx: TransactionIntent, bidRecipient: string) {
  console.log('-'.repeat(64))
  if (tx.to == env['UNISWAP_V3_ROUTER'] && tx.data) {
    console.log('Uniswap tx found!')
    return handleUniswapV3Trade(hash, tx, bidRecipient)
  } else if (tx.to == env['UNISWAP_UNIVERAL_ROUTER'] && tx.data) {
    console.log('Uniswap universal swap found!')
    return handleUniswapUniversalTrade(hash, tx, bidRecipient)
  } else {
    reportAddressEvent(tx.from!, `Searcher: Tx ${hash} not directed to Uniswap V3 Router. Skipping.`)
    console.log('Not directed to V3 router or not a smart contract call', tx.to, tx.data)
  }
}

const handleUniswapV3Trade = async (hash: string, tx: TransactionIntent, bidRecipient: string) => {
  // Ignore if not a allowlisted user
  // const allowedAddresses = JSON.parse(env['ALLOWED_ADDRESSES']) as string[]
  // if (!tx.from || (tx.from && allowedAddresses.indexOf(tx.from) < 0)) {
  //   console.error('user not in allowlist', tx.from)
  //   return
  // }

  // 1. Decode the transaction data
  const decodedUniswapV3Multicall = await decodeRaw(tx.data)
  if (!decodedUniswapV3Multicall) {
    reportAddressEvent(tx.from!, `Searcher: Failed to decode Uniswap tx ${hash}. Skipping.`)
    console.error('not a multicall')
    return
  } else {
    console.log('Uniswap tx decoded')
  }

  // 1.1 Parse decoded data
  const uniswapV3Trade = getUniswapV3TradeParams(decodedUniswapV3Multicall, tx.from)
  if (!uniswapV3Trade) {
    // No calls, or no exactInputSingle
    reportAddressEvent(tx.from!, `Searcher: Uniswap tx ${hash} is not a simple exactInputSingle swap. Skipping.`)
    return
  }

  reportAddressEvent(tx.from!, `Searcher: Found UniswapV3 exactInputSingle in tx ${hash}`)

  console.log('Found exactInputSingle call with parameters:', uniswapV3Trade)

  // 2. Get Uniswap v3 pool address from Factory contract
  const pool = await uniV3Factory.getPool(uniswapV3Trade.tokenIn, uniswapV3Trade.tokenOut, uniswapV3Trade.fee)
  console.log('Uniswap V3 Pool for the pair:', pool)

  // Ignore, if not the test pool
  if (pool !== env['TOKEN_UNIV3_POOL']) {
    console.log('Tx not on test pool')
    return
  }

  // Ignore, if selling token, not buying it.
  if (uniswapV3Trade.tokenIn !== WETH.address) {
    console.log('Tx selling token, not buying')
    reportAddressEvent(tx.from!, `Searcher: Uniswap tx ${hash} is selling, not buying the token. Skipping.`)
    return
  }

  /*
    Bundle Plan:
    1. User transaction: buy Token with ETH, using `value` ETH
    - increases Token/ETH price on UniV3 vs Sushi
    - allows buying Token cheaper on Sushi and selling on Uniswap
    Create two arbitrage transactions:
    2. Buy on Sushi pool (buy Token/ETH)
    - increase to an equilibrium price post selling
    3. Sell Token for ETH on the inflated UniV3 pool (sell Token/ETH)
    - results in profit in ETH
   */

  // Deadline in 6 minutes
  const tradesDeadline = Date.now() + 1000 * 60 * 6
  const currentNonce = (await rpc.getTransactionCount(wallet.address, 'latest')) - 1

  // 3. Buy on Sushi pool, half as much as user paid
  const sushiETHAmount = BigNumber.from(tx.value).div(2)

  // Get the minimum amount of the token out, contract returns [amountIn, amountOut]
  const sushiTokenAmount = (await sushiRouter.getAmountsOut(sushiETHAmount, [WETH.address, SwapToken.address]))[1]

  const sushiTrade = {
    amountOutMin: sushiTokenAmount,
    path: [WETH.address, SwapToken.address], // from WETH to Tokens
    to: wallet.address,
    deadline: tradesDeadline,
    value: sushiETHAmount,
  }

  console.log('\nSushi ETH->Token swap:', sushiTrade)

  const populatedSushiBuyTx = await sushiRouter.populateTransaction.swapExactETHForTokens(
    sushiTrade.amountOutMin,
    sushiTrade.path,
    sushiTrade.to,
    sushiTrade.deadline,
    {
      value: sushiTrade.value,
      nonce: currentNonce + 1,
    }
  )
  const filledSushiTx = await wallet.populateTransaction(populatedSushiBuyTx)
  const signedSushiBuyTx = await wallet.signTransaction(filledSushiTx)
  const decodedSushiBuyTx = ethers.utils.parseTransaction(signedSushiBuyTx)
  // console.log('compare', populatedSushiBuyTx, filledSushiTx, decodedSushiBuyTx)
  // console.log('dbg', decodedSushiBuyTx)

  console.log('\nSushi: Swap Hash:', decodedSushiBuyTx.hash)
  console.log('       Minimum amount out in Tokens:', ethers.utils.formatEther(sushiTrade.amountOutMin))
  console.log('       Cost in ETH:', ethers.utils.formatEther(sushiTrade.value))

  // 4. Sell on inflated UniV3 pool
  const tokenAmount = CurrencyAmount.fromRawAmount(SwapToken, sushiTokenAmount.toString())

  // Get route from auto router
  const uniV3RouterSwap = await uniV3AlphaRouter.route(tokenAmount, WETH, TradeType.EXACT_INPUT, {
    type: Router.SwapType.SWAP_ROUTER_02,
    recipient: wallet.address,
    slippageTolerance: new Percent(5, 100),
    deadline: tradesDeadline,
  })

  if (!uniV3RouterSwap || !uniV3RouterSwap.methodParameters) {
    console.error('No route found')
    return
  }

  // console.log('uni dbg', maxFeePerGas)
  // console.log(uniV3RouterSwap.gasPriceWei)
  // console.log(uniV3RouterSwap.estimatedGasUsed)

  const uniSellTx: ethers.providers.TransactionRequest = {
    from: wallet.address,
    to: env['UNISWAP_V3_ROUTER'],
    data: uniV3RouterSwap.methodParameters.calldata,
    value: uniV3RouterSwap.methodParameters.value,
    nonce: currentNonce + 2,
    // gasLimit: uniV3RouterSwap.estimatedGasUsed,
    // gasPrice: maxFeePerGas, // instead of uniV3RouterSwap.gasPriceWei,
  }

  const filledUniSellTx = await wallet.populateTransaction(uniSellTx)
  console.log('filled uni', filledUniSellTx)
  const signedUniSellTx = await wallet.signTransaction(filledUniSellTx)
  const decodedUniSell = ethers.utils.parseTransaction(signedUniSellTx)

  const uniV3SwapETHOut = uniV3RouterSwap.trade.outputAmount.toSignificant()
  console.log('\nUniV3: Swap Hash:', decodedUniSell.hash)
  console.log('       ETH Out:', uniV3SwapETHOut)

  // 5. If profit lower than 0.001 ETH, bid 0.001 ETH, otherwise bid 80% of profit

  // How much we got from UniV3 sell minus how much we paid to Sushi
  // Totally meaningless, as currently we don't simulate user's trasnactions
  // Ignores gas
  const profitAsBigNumber = ethers.utils.parseEther(uniV3SwapETHOut).sub(sushiETHAmount)
  console.log('\nProfit in ETH:', ethers.utils.formatEther(profitAsBigNumber))

  const bidAmount = profitAsBigNumber.lt(ethers.utils.parseEther('0.001'))
    ? ethers.utils.parseEther('0.001')
    : profitAsBigNumber.mul(8).div(10).toNumber()
  console.log('Bid in ETH:', ethers.utils.formatEther(bidAmount))

  reportAddressEvent(
    tx.from!,
    `Searcher: Arbitrage strategy formed for tx ${hash}, bidding ${ethers.utils.formatEther(bidAmount)}`
  )

  // Formulate bid transaction as payment to auction house
  const bidTx = await wallet.populateTransaction({
    to: bidRecipient,
    value: bidAmount,
    nonce: currentNonce + 3,
  })
  const signedBidTx = await wallet.signTransaction(bidTx)

  const bundle: TransactionBundle = [
    { hash }, // original user transaction
    { signedTransaction: signedSushiBuyTx }, // signed sushi buy tx
    { signedTransaction: signedUniSellTx }, // signed uni sell tx
    { signedTransaction: signedBidTx }, // bid tx
  ]
  console.log('Bundle:', bundle)
  return bundle
}

const handleUniswapUniversalTrade = async (hash: string, tx: TransactionIntent, bidRecipient: string) => {
  // Ignore if not a allowlisted user
  // const allowedAddresses = JSON.parse(env['ALLOWED_ADDRESSES']) as string[]
  // if (!tx.from || (tx.from && allowedAddresses.indexOf(tx.from) < 0)) {
  //   console.error('user not in allowlist', tx.from)
  //   return
  // }

  // 1. Decode the transaction data
  const decodedUniswapCommand = await decodeUniversalRaw(tx.data)
  console.log(decodedUniswapCommand)
  if (!decodedUniswapCommand) {
    reportAddressEvent(tx.from!, `Searcher: Failed to decode Uniswap tx ${hash}. Skipping.`)
    console.error('not a multicall')
    return
  } else {
    console.log('Uniswap tx decoded')
  }

  // 1.1 Parse decoded data
  const uniswapV3Trade = getUniswapUniversalTradeParams(decodedUniswapCommand, tx.from)
  if (!uniswapV3Trade) {
    // No calls, or no exactInputSingle
    reportAddressEvent(tx.from!, `Searcher: Uniswap tx ${hash} is not a simple exactInputSingle swap. Skipping.`)
    return
  }

  // reportAddressEvent(tx.from!, `Searcher: Found UniswapV3 exactInputSingle in tx ${hash}`)

  console.log('Found exactInputSingle call with parameters:', uniswapV3Trade)

  // 2. Get Uniswap v3 pool address from Factory contract
  let pool = env['TOKEN_UNIV3_POOL']
  try {
    pool = await uniV3Factory.getPool(uniswapV3Trade.tokenIn, uniswapV3Trade.tokenOut, uniswapV3Trade.fee)
    console.log('Uniswap V3 Pool for the pair:', pool)

    // Ignore, if not the test pool
    if (pool !== env['TOKEN_UNIV3_POOL']) {
      console.log('Tx not on test pool')
      return
    }
  } catch (error) {
    console.error('error trying to get pool, defaulting to expected value', error)
  }

  // Ignore, if selling token, not buying it.
  if (uniswapV3Trade.tokenIn.toLowerCase() !== WETH.address.toLowerCase()) {
    console.log('Tx selling token, not buying')
    reportAddressEvent(tx.from!, `Searcher: Uniswap tx ${hash} is selling, not buying the token. Skipping.`)
    return
  }

  const sellETHAmount = uniswapV3Trade.amountIn.value

  /*
    Bundle Plan:
    1. User transaction: buy Token with ETH, using `value` ETH
    - increases Token/ETH price on UniV3 vs Sushi
    - allows buying Token cheaper on Sushi and selling on Uniswap
    Create two arbitrage transactions:
    2. Buy on Sushi pool (buy Token/ETH)
    - increase to an equilibrium price post selling
    3. Sell Token for ETH on the inflated UniV3 pool (sell Token/ETH)
    - results in profit in ETH
   */

  // Deadline in 6 minutes
  const tradesDeadline = Date.now() + 1000 * 60 * 6
  const currentNonce = (await rpc.getTransactionCount(wallet.address, 'latest')) - 1

  // 3. Buy on Sushi pool, half as much as user paid
  const sushiETHAmount = BigNumber.from(sellETHAmount).div(2)

  // Get the minimum amount of the token out, contract returns [amountIn, amountOut]
  const sushiTokenAmount = (await sushiRouter.getAmountsOut(sushiETHAmount, [WETH.address, SwapToken.address]))[1]

  const sushiTrade = {
    amountOutMin: sushiTokenAmount,
    path: [WETH.address, SwapToken.address], // from WETH to Tokens
    to: wallet.address,
    deadline: tradesDeadline,
    value: sushiETHAmount,
  }

  console.log('\nSushi ETH->Token swap:', sushiTrade)

  const populatedSushiBuyTx = await sushiRouter.populateTransaction.swapExactETHForTokens(
    sushiTrade.amountOutMin,
    sushiTrade.path,
    sushiTrade.to,
    sushiTrade.deadline,
    {
      value: sushiTrade.value,
      nonce: currentNonce + 1,
    }
  )
  const filledSushiTx = await wallet.populateTransaction(populatedSushiBuyTx)
  const signedSushiBuyTx = await wallet.signTransaction(filledSushiTx)
  const decodedSushiBuyTx = ethers.utils.parseTransaction(signedSushiBuyTx)
  // console.log('compare', populatedSushiBuyTx, filledSushiTx, decodedSushiBuyTx)
  // console.log('dbg', decodedSushiBuyTx)

  console.log('\nSushi: Swap Hash:', decodedSushiBuyTx.hash)
  console.log('       Minimum amount out in Tokens:', ethers.utils.formatEther(sushiTrade.amountOutMin))
  console.log('       Cost in ETH:', ethers.utils.formatEther(sushiTrade.value))

  // 4. Sell on inflated UniV3 pool
  const tokenAmount = CurrencyAmount.fromRawAmount(SwapToken, sushiTokenAmount.toString())

  // Get route from auto router
  const uniV3RouterSwap = await uniV3AlphaRouter.route(tokenAmount, WETH, TradeType.EXACT_INPUT, {
    type: Router.SwapType.SWAP_ROUTER_02,
    recipient: wallet.address,
    slippageTolerance: new Percent(5, 100),
    deadline: tradesDeadline,
  })

  if (!uniV3RouterSwap || !uniV3RouterSwap.methodParameters) {
    console.error('No route found')
    return
  }

  // console.log('uni dbg', maxFeePerGas)
  // console.log(uniV3RouterSwap.gasPriceWei)
  // console.log(uniV3RouterSwap.estimatedGasUsed)

  const uniSellTx: ethers.providers.TransactionRequest = {
    from: wallet.address,
    to: env['UNISWAP_V3_ROUTER'],
    data: uniV3RouterSwap.methodParameters.calldata,
    value: uniV3RouterSwap.methodParameters.value,
    nonce: currentNonce + 2,
    // gasLimit: uniV3RouterSwap.estimatedGasUsed,
    // gasPrice: maxFeePerGas, // instead of uniV3RouterSwap.gasPriceWei,
  }

  const filledUniSellTx = await wallet.populateTransaction(uniSellTx)
  console.log('filled uni', filledUniSellTx)
  const signedUniSellTx = await wallet.signTransaction(filledUniSellTx)
  const decodedUniSell = ethers.utils.parseTransaction(signedUniSellTx)

  const uniV3SwapETHOut = uniV3RouterSwap.trade.outputAmount.toSignificant()
  console.log('\nUniV3: Swap Hash:', decodedUniSell.hash)
  console.log('       ETH Out:', uniV3SwapETHOut)

  // 5. If profit lower than 0.001 ETH, bid 0.001 ETH, otherwise bid 80% of profit

  // How much we got from UniV3 sell minus how much we paid to Sushi
  // Totally meaningless, as currently we don't simulate user's trasnactions
  // Ignores gas
  const profitAsBigNumber = ethers.utils.parseEther(uniV3SwapETHOut).sub(sushiETHAmount)
  console.log('\nProfit in ETH:', ethers.utils.formatEther(profitAsBigNumber))

  const bidAmount = profitAsBigNumber.lt(ethers.utils.parseEther('0.001'))
    ? ethers.utils.parseEther('0.001')
    : profitAsBigNumber.mul(8).div(10).toNumber()
  console.log('Bid in ETH:', ethers.utils.formatEther(bidAmount))

  reportAddressEvent(
    tx.from!,
    `Searcher: Arbitrage strategy formed for tx ${hash}, bidding ${ethers.utils.formatEther(bidAmount)}`
  )

  // Formulate bid transaction as payment to auction house
  const bidTx = await wallet.populateTransaction({
    to: bidRecipient,
    value: bidAmount,
    nonce: currentNonce + 3,
  })
  const signedBidTx = await wallet.signTransaction(bidTx)

  const bundle: TransactionBundle = [
    { hash }, // original user transaction
    { signedTransaction: signedSushiBuyTx }, // signed sushi buy tx
    { signedTransaction: signedUniSellTx }, // signed uni sell tx
    { signedTransaction: signedBidTx }, // bid tx
  ]
  console.log('Bundle:', bundle)
  return bundle
}
