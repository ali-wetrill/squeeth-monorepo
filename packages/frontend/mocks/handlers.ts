import { rest } from 'msw'
import coingeckoData from './price_data/coingecko.json'
import twelveData from './price_data/twelvedata.json'

export const handlers = [
  rest.get('https://api.coingecko.com/api/v3/coins/ethereum/market_chart', (req, res, ctx) => {
    const query = req.url.searchParams
    const currency = query.get('vs_currency')
    const days = query.get('days')

    if (currency && days) {
      return res(ctx.status(200), ctx.json(coingeckoData))
    }
  }),

  rest.get(/\/api\/twelvedata/, (req, res, ctx) => {
    const query = req.url.searchParams
    const path = query.get('path')
    const start_date = query.get('start_date')
    const end_date = query.get('end_date')
    const symbol = query.get('symbol')
    const interval = query.get('interval')

    if (path && path === 'time_series' && start_date && end_date && symbol && interval) {
      const price = twelveData.values.find((price) => price.datetime === start_date) ?? twelveData.values[0]

      return res(ctx.status(200), ctx.json({ meta: twelveData.meta, values: [price], status: twelveData.status }))
    }
  }),
]