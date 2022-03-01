import { atom, useAtomValue } from 'jotai'
import { useQuery } from 'react-query'

import { getCUSDCPrices, getETH90DaysPrices, getETHPrices, getETHWithinOneDayPrices } from '@hooks/useETHPriceCharts'
import { getETHPNLCompounding, getSqueethChartWithFunding, getSqueethPNLCompounding } from '@utils/pricer'
import { useCallback } from 'react'

const FIVE_MINUTES_IN_MILLISECONDS = 300_000
const ethPriceChartsQueryKeys = {
  ethPriceRange: (days: number) => ['ethPriceRange', { days }],
  allEthPricesRange: (days: number) => ['allEthPricesRange', { days }],
  allEth90daysPrices: () => ['allEth90daysPrices'],
  allEthWithinOneDayPrices: () => ['allEthWithinOneDayPrices'],
  cusdcPricesRange: (days: number) => ['cusdcPricesRange', { days }],
  squeethSeries: (ethPrices: any, volMultiplier: number, collatRatio: number) => [
    'squeethSeries',
    { ethPricesData: ethPrices, volMultiplier, collatRatio },
  ],
  squeethPNLSeries: (ethPrices: any, volMultiplier: number, collatRatio: number, days: number) => [
    'squeethPNLSeries',
    { ethPricesData: ethPrices, volMultiplier, collatRatio, days },
  ],
  ethPNLCompounding: (ethPrices: any) => ['ethPNLCompounding', { ethPricesData: ethPrices }],
}

export const daysAtom = atom(365)
export const collatRatioAtom = atom(1.5)
export const volMultiplierAtom = atom(1.2)

export const useEthPrices = () => {
  const days = useAtomValue(daysAtom)

  return useQuery(ethPriceChartsQueryKeys.ethPriceRange(days), () => getETHPrices(days), {
    enabled: Boolean(days),
    staleTime: FIVE_MINUTES_IN_MILLISECONDS,
  })
}

export const useAllEthPrices = () => {
  const days = useAtomValue(daysAtom)

  return useQuery(ethPriceChartsQueryKeys.allEthPricesRange(days), () => getETHPrices(days), {
    enabled: Boolean(days),
    staleTime: FIVE_MINUTES_IN_MILLISECONDS,
  })
}

export const useAllEth90daysPrices = () => {
  return useQuery(ethPriceChartsQueryKeys.allEth90daysPrices(), () => getETH90DaysPrices(), {
    staleTime: FIVE_MINUTES_IN_MILLISECONDS,
  })
}

export const useAllEthWithinOneDayPrices = () => {
  return useQuery(ethPriceChartsQueryKeys.allEthWithinOneDayPrices(), () => getETHWithinOneDayPrices(), {
    staleTime: FIVE_MINUTES_IN_MILLISECONDS,
  })
}

export const useCusdcPrices = () => {
  const days = useAtomValue(daysAtom)

  return useQuery(ethPriceChartsQueryKeys.cusdcPricesRange(days), () => getCUSDCPrices(days), {
    staleTime: FIVE_MINUTES_IN_MILLISECONDS,
  })
}

export const useEthPNLCompounding = () => {
  const ethPrices = useEthPrices()

  return useQuery(
    ethPriceChartsQueryKeys.ethPNLCompounding(ethPrices.data),
    () => getETHPNLCompounding(ethPrices.data ?? []),
    {
      enabled: Boolean(ethPrices.isSuccess && ethPrices.data),
    },
  )
}

export const useSqueethSeries = () => {
  const ethPrices = useEthPrices()
  const volMultiplier = useAtomValue(volMultiplierAtom)
  const collatRatio = useAtomValue(collatRatioAtom)

  return useQuery(
    ethPriceChartsQueryKeys.squeethSeries(ethPrices.data, volMultiplier, collatRatio),
    () => getSqueethChartWithFunding(ethPrices.data ?? [], volMultiplier, collatRatio),
    { enabled: Boolean(ethPrices.isSuccess && ethPrices.data) },
  )
}

export const useAccFunding = () => {
  const squeethSeries = useSqueethSeries()
  return squeethSeries.data?.accFunding
}

export const useSqueethPNLSeries = () => {
  const ethPrices = useEthPrices()
  const days = useAtomValue(daysAtom)
  const volMultiplier = useAtomValue(volMultiplierAtom)
  const collatRatio = useAtomValue(collatRatioAtom)

  return useQuery(
    ethPriceChartsQueryKeys.squeethPNLSeries(ethPrices?.data, volMultiplier, collatRatio, days),
    () => getSqueethPNLCompounding(ethPrices.data ?? [], volMultiplier, collatRatio, days),
    { enabled: Boolean(ethPrices.isSuccess && ethPrices.data && days) },
  )
}

export const useLongSeries = () => {
  const squeethPNLSeries = useSqueethPNLSeries()

  return squeethPNLSeries.data
    ? squeethPNLSeries.data.map(({ time, longPNL }) => {
        return { time, value: longPNL }
      })
    : []
}

export const useShortSeries = () => {
  const squeethPNLSeries = useSqueethPNLSeries()

  return squeethPNLSeries.data
    ? squeethPNLSeries.data.map(({ time, shortPNL }) => {
        return { time, value: shortPNL }
      })
    : []
}

export const usePrevShortSeries = () => {
  const squeethSeries = useSqueethSeries()

  return squeethSeries.data
    ? squeethSeries.data.series.map(({ time, shortPNL }) => {
        return { time, value: shortPNL }
      })
    : []
}

export const usePositionSizePercentageseries = () => {
  const squeethSeries = useSqueethSeries()

  return (
    squeethSeries.data &&
    squeethSeries.data.series.map(({ time, positionSize }) => {
      return { time, value: positionSize * 100 }
    })
  )
}

export const useFundingPercentageSeries = () => {
  const squeethSeries = useSqueethSeries()

  return squeethSeries.data
    ? squeethSeries.data.series.map(({ time, fundingPerSqueeth, mark, timeElapsed: timeElapsedInDay }) => {
        const fundingPercentageDay = fundingPerSqueeth / mark / timeElapsedInDay
        return { time, value: Number((fundingPercentageDay * 100).toFixed(4)) }
      })
    : []
}

export const useLongEthPNL = () => {
  const ethPNLCompounding = useEthPNLCompounding()

  return ethPNLCompounding.data
    ? ethPNLCompounding.data.map(({ time, longPNL }) => {
        return { time, value: longPNL }
      })
    : []
}

export const useShortEthPNL = () => {
  const ethPNLCompounding = useEthPNLCompounding()

  return ethPNLCompounding.data
    ? ethPNLCompounding.data.map(({ time, shortPNL }) => {
        return { time, value: shortPNL }
      })
    : []
}

export const useStartingETHPrice = () => {
  const ethPrices = useEthPrices()
  return ethPrices.data && ethPrices.data.length > 0 ? ethPrices.data[0].value : 1
}

export const useSqueethPrices = () => {
  const ethPrices = useEthPrices()
  const startingETHPrice = useStartingETHPrice()

  return ethPrices.data
    ? ethPrices.data.map(({ time, value }) => {
        return { time, value: value ** 2 / startingETHPrice }
      })
    : []
}

export const useEthPriceMap = () => {
  const allEthPrices = useAllEthPrices()

  return (
    allEthPrices.data &&
    allEthPrices.data.reduce((acc, p) => {
      acc[p.time] = p.value
      return acc
    }, {} as Record<string, number>)
  )
}

export const useEth90daysPriceMap = () => {
  const allEth90daysPrices = useAllEth90daysPrices()

  return (
    allEth90daysPrices.data &&
    allEth90daysPrices.data.reduce((acc, p) => {
      acc[p.time] = p.value
      return acc
    }, {} as Record<string, number>)
  )
}

export const useEthWithinOneDayPriceMap = () => {
  const allEthWithinOneDayPrices = useAllEthWithinOneDayPrices()

  return allEthWithinOneDayPrices.data
    ? allEthWithinOneDayPrices.data.reduce((acc: any, p) => {
        acc[p.time] = p.value
        return acc
      }, {})
    : {}
}

export const useGetVaultPNLWithRebalance = () => {
  const ethPrices = useEthPrices().data
  const squeethSeries = useSqueethSeries().data
  const prevShortSeries = usePrevShortSeries()
  const startingETHPrice = useStartingETHPrice()

  return useCallback(
    (n: number, rebalanceInterval = 86400) => {
      if (!squeethSeries || squeethSeries.series.length === 0) return []
      if (!ethPrices || !prevShortSeries) return
      if (ethPrices && squeethSeries.series.length !== ethPrices.length) return []

      const delta = n - 2 // fix delta we want to hedge to. (n - 2)
      const normalizedFactor = startingETHPrice

      // how much eth holding throughout the time
      let longAmount = n
      const data: { time: number; value: number }[] = []
      let nextRebalanceTime = ethPrices[0].time + rebalanceInterval

      // set uniswap fee
      const UNISWAP_FEE = 0.003

      // accumulate total cost of buying (or selling) eth
      let totalLongCost = startingETHPrice * longAmount

      ethPrices.forEach(({ time, value: price }, i) => {
        if (time > nextRebalanceTime) {
          const m = squeethSeries.series[i].positionSize

          // rebalance
          const x = price / normalizedFactor

          // solve n for formula:
          // n - 2mx = m * delta
          const newN = m * delta + 2 * x * m
          const buyAmount = newN - longAmount
          const buyCost = buyAmount * price + Math.abs(buyAmount * price * UNISWAP_FEE)
          //console.log(`Date ${new Date(time * 1000).toDateString()}, price ${price.toFixed(3)} Rebalance: short squeeth ${m.toFixed(4)}, desired ETH long ${newN.toFixed(4)}, buy ${buyAmount.toFixed(4)} more eth`)

          totalLongCost += buyCost
          longAmount = newN

          //console.log('total long cost', totalLongCost, 'longAmount', longAmount)

          //normalizedFactor = price
          nextRebalanceTime = nextRebalanceTime + rebalanceInterval
        }

        const longValue = price * longAmount - totalLongCost // should probably be be named something like ethDeltaPnL
        const realizedPNL = prevShortSeries[i].value + longValue

        // calculate how much eth to buy
        data.push({
          time: time,
          value: realizedPNL,
        })
      })

      return data
    },
    [ethPrices, prevShortSeries, squeethSeries, startingETHPrice],
  )
}

export const useGetStableYieldPNL = () => {
  const cusdcPrices = useCusdcPrices().data
  const startingETHPrice = useStartingETHPrice()

  return useCallback(
    (comparedLongAmount: number) => {
      if (!cusdcPrices || cusdcPrices.length === 0) return []

      // price of one unit of cUSDC
      const startCUSDCPrice = cusdcPrices[0].value
      const amountCUSDC = (startingETHPrice * comparedLongAmount) / startCUSDCPrice
      return cusdcPrices.map(({ time, value }) => {
        const pnlPerct =
          Math.round(
            ((amountCUSDC * value - startingETHPrice * comparedLongAmount) / (startingETHPrice * comparedLongAmount)) *
              10000,
          ) / 100
        return {
          time,
          value: pnlPerct,
        }
      })
    },
    [cusdcPrices, startingETHPrice],
  )
}