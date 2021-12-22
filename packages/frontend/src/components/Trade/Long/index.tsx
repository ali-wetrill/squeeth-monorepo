import { CircularProgress, createStyles, makeStyles, Typography } from '@material-ui/core'
import ArrowRightAltIcon from '@material-ui/icons/ArrowRightAlt'
import BigNumber from 'bignumber.js'
import React, { useCallback, useEffect, useState } from 'react'

import { WSQUEETH_DECIMALS } from '../../../constants'
import { useTrade } from '@context/trade'
import { useWallet } from '@context/wallet'
import { useUserAllowance } from '@hooks/contracts/useAllowance'
import { useSqueethPool } from '@hooks/contracts/useSqueethPool'
import { useTokenBalance } from '@hooks/contracts/useTokenBalance'
import { useAddresses } from '@hooks/useAddress'
import { useETHPrice } from '@hooks/useETHPrice'
import { useLongPositions, useShortPositions } from '@hooks/usePositions'
import { PrimaryButton } from '@components/Button'
import { PrimaryInput } from '@components/Input/PrimaryInput'
import { UniswapIframe } from '@components/Modal/UniswapIframe'
import { TradeSettings } from '@components/TradeSettings'
import Confirmed from '../Confirmed'
import TradeInfoItem from '../TradeInfoItem'
import UniswapData from '../UniswapData'

const useStyles = makeStyles((theme) =>
  createStyles({
    header: {
      color: theme.palette.primary.main,
    },
    body: {
      padding: theme.spacing(2, 12),
      margin: 'auto',
      display: 'flex',
      justifyContent: 'space-around',
    },
    subHeading: {
      color: theme.palette.text.secondary,
    },
    thirdHeading: {
      marginTop: theme.spacing(2),
      paddingLeft: theme.spacing(1),
      paddingRight: theme.spacing(1),
    },
    explainer: {
      marginTop: theme.spacing(2),
      paddingLeft: theme.spacing(1),
      paddingRight: theme.spacing(1),
      marginLeft: theme.spacing(1),
      width: '200px',
      justifyContent: 'left',
    },
    caption: {
      marginTop: theme.spacing(1),
    },
    divider: {
      margin: theme.spacing(2, 0),
      width: '300px',
      marginLeft: 'auto',
      marginRight: 'auto',
    },
    details: {
      marginTop: theme.spacing(4),
      width: '65%',
    },
    buyCard: {
      marginTop: theme.spacing(4),
      marginLeft: theme.spacing(2),
    },
    cardTitle: {
      color: theme.palette.primary.main,
      marginTop: theme.spacing(4),
    },
    cardSubTxt: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
      width: '90%',
    },
    payoff: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
    },
    cardDetail: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
      marginTop: theme.spacing(4),
    },
    amountInput: {
      marginTop: theme.spacing(1),
      backgroundColor: theme.palette.success.main,
      '&:hover': {
        backgroundColor: theme.palette.success.dark,
      },
    },
    innerCard: {
      textAlign: 'center',
      padding: theme.spacing(2),
      paddingBottom: theme.spacing(8),
      background: theme.palette.background.default,
      border: `1px solid ${theme.palette.background.stone}`,
    },
    expand: {
      transform: 'rotate(270deg)',
      color: theme.palette.primary.main,
      transition: theme.transitions.create('transform', {
        duration: theme.transitions.duration.shortest,
      }),
      marginTop: theme.spacing(6),
    },
    expandOpen: {
      transform: 'rotate(180deg)',
      color: theme.palette.primary.main,
    },
    dialog: {
      padding: theme.spacing(2),
    },
    dialogHeader: {
      display: 'flex',
      alignItems: 'center',
    },
    dialogIcon: {
      marginRight: theme.spacing(1),
      color: theme.palette.warning.main,
    },
    txItem: {
      marginTop: theme.spacing(1),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    infoIcon: {
      marginLeft: theme.spacing(0.5),
      color: theme.palette.text.secondary,
    },
    squeethExp: {
      display: 'flex',
      justifyContent: 'space-between',
      borderRadius: theme.spacing(1),
      padding: theme.spacing(1.5),
      width: '300px',
      marginLeft: 'auto',
      marginRight: 'auto',
      marginTop: theme.spacing(2),
      textAlign: 'left',
      backgroundColor: theme.palette.background.stone,
    },
    squeethExpTxt: {
      fontSize: '20px',
    },
    closePosition: {
      display: 'flex',
      justifyContent: 'space-between',
      padding: theme.spacing(0, 1),
    },
    closeBtn: {
      color: theme.palette.error.main,
    },
    paper: {
      backgroundColor: theme.palette.background.paper,
      boxShadow: theme.shadows[5],
      borderRadius: theme.spacing(1),
      width: '350px',
      textAlign: 'center',
      paddingBottom: theme.spacing(2),
    },
    modal: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonDiv: {
      position: 'sticky',
      bottom: '0',
      background: '#2A2D2E',
      paddingBottom: theme.spacing(3),
    },
    hint: {
      display: 'flex',
      alignItems: 'center',
    },
    arrowIcon: {
      marginLeft: '4px',
      marginRight: '4px',
      fontSize: '20px',
    },
    hintTextContainer: {
      display: 'flex',
    },
    hintTitleText: {
      marginRight: '.5em',
    },
    linkHover: {
      '&:hover': {
        opacity: 0.7,
      },
    },
    anchor: {
      color: '#FF007A',
      fontSize: '16px',
    },
    settingsContainer: {
      display: 'flex',
      justify: 'space-between',
    },
    settingsButton: {
      marginTop: theme.spacing(2),
      marginLeft: theme.spacing(10),
      justifyContent: 'right',
    },
  }),
)

const OpenLong: React.FC<BuyProps> = ({ balance, open, activeStep = 0 }) => {
  const [buyLoading, setBuyLoading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [txHash, setTxHash] = useState('')

  const classes = useStyles()
  const { wSqueeth } = useAddresses()
  const wSqueethBal = useTokenBalance(wSqueeth, 5, WSQUEETH_DECIMALS)
  const { buyAndRefund, getWSqueethPositionValue, getBuyQuoteForETH, getBuyQuote } = useSqueethPool()
  const {
    tradeAmount: amount,
    setTradeAmount: setAmount,
    squeethExposure,
    quote,
    altTradeAmount,
    setAltTradeAmount,
    setTradeSuccess,
    slippageAmount,
  } = useTrade()
  const { selectWallet, connected } = useWallet()
  const ethPrice = useETHPrice()
  const { squeethAmount: shrtAmt } = useShortPositions()

  useEffect(() => {
    if (!open && wSqueethBal.lt(amount)) {
      setAmount(wSqueethBal)
    }
  }, [wSqueethBal, open])

  let openError: string | undefined
  let closeError: string | undefined
  let existingShortError: string | undefined
  let priceImpactWarning: string | undefined

  if (connected) {
    if (wSqueethBal.lt(amount)) {
      closeError = 'Insufficient oSQTH balance'
    }
    if (amount.gt(balance)) {
      openError = 'Insufficient ETH balance'
    }
    if (shrtAmt.gt(0)) {
      existingShortError = 'Close your short position to open a long'
    }
    if (new BigNumber(quote.priceImpact).gt(3)) {
      priceImpactWarning = 'High Price Impact'
    }
  }
  const longOpenPriceImpactErrorState = priceImpactWarning && !buyLoading && !openError && !shrtAmt.gt(0)

  const transact = async () => {
    setBuyLoading(true)
    try {
      const confirmedHash = await buyAndRefund(amount)
      setConfirmed(true)
      setTxHash(confirmedHash.transactionHash)
      setTradeSuccess(true)
    } catch (e) {
      console.log(e)
    }
    setBuyLoading(false)
  }
  const handleOpenDualInputUpdate = (v: number | string, currentInput: string) => {
    //If I'm inputting an amount of ETH I'd like to spend to get squeeth, use getBuyQuoteForETH
    console.log('Hello world called from here', slippageAmount.toNumber())
    if (isNaN(+v) || +v === 0) v = 0
    if (currentInput === 'ETH') {
      setAmount(new BigNumber(v))
      getBuyQuoteForETH(new BigNumber(v)).then((val) => {
        setAltTradeAmount(val.amountOut)
      })
    } else {
      //If I'm inputting an amount of squeeth I'd like to buy with ETH, use getBuyQuote
      setAltTradeAmount(new BigNumber(v))
      getBuyQuote(new BigNumber(v)).then((val) => {
        setAmount(val.amountIn)
      })
    }
  }
  return (
    <div>
      {!confirmed ? (
        <div>
          {activeStep === 0 ? (
            <>
              <div className={classes.settingsContainer}>
                <Typography variant="caption" className={classes.explainer} component="div">
                  Pay ETH to buy squeeth ERC20
                </Typography>
                <span className={classes.settingsButton}>
                  <TradeSettings />
                </span>
              </div>
              <div className={classes.thirdHeading} />
              <PrimaryInput
                value={amount.toNumber().toString()}
                onChange={(v) => handleOpenDualInputUpdate(v, 'ETH')}
                label="Amount"
                tooltip="Amount of ETH you want to spend to get Squeeth exposure"
                actionTxt="Max"
                onActionClicked={() => {
                  setAmount(new BigNumber(balance))
                  getBuyQuoteForETH(new BigNumber(balance)).then((val) => {
                    setAltTradeAmount(val.amountOut)
                  })
                }}
                unit="ETH"
                convertedValue={amount.times(ethPrice).toFixed(2).toLocaleString()}
                error={!!existingShortError || !!priceImpactWarning || !!openError}
                hint={
                  openError ? (
                    openError
                  ) : existingShortError ? (
                    existingShortError
                  ) : priceImpactWarning ? (
                    priceImpactWarning
                  ) : (
                    <div className={classes.hint}>
                      <span>{`Balance ${balance}`}</span>
                      {amount.toNumber() ? (
                        <>
                          <ArrowRightAltIcon className={classes.arrowIcon} />
                          <span>{(balance - amount.toNumber()).toFixed(6)}</span>
                        </>
                      ) : null}{' '}
                      <span style={{ marginLeft: '4px' }}>ETH</span>
                    </div>
                  )
                }
              />

              <PrimaryInput
                value={altTradeAmount.toNumber().toString()}
                onChange={(v) => handleOpenDualInputUpdate(v, 'oSQTH')}
                label="Amount"
                tooltip="Amount of Squeeth exposure"
                actionTxt="Max"
                unit="oSQTH"
                convertedValue={getWSqueethPositionValue(altTradeAmount).toFixed(2).toLocaleString()}
                error={!!existingShortError || !!priceImpactWarning || !!openError}
                hint={
                  openError ? (
                    openError
                  ) : existingShortError ? (
                    existingShortError
                  ) : priceImpactWarning ? (
                    priceImpactWarning
                  ) : (
                    <div className={classes.hint}>
                      <span className={classes.hintTextContainer}>
                        <span className={classes.hintTitleText}>Balance </span>
                        <span>{wSqueethBal.toFixed(6)}</span>
                      </span>
                      {quote.amountOut.gt(0) ? (
                        <>
                          <ArrowRightAltIcon className={classes.arrowIcon} />
                          <span>{wSqueethBal.plus(quote.amountOut).toFixed(6)}</span>
                        </>
                      ) : null}{' '}
                      <span style={{ marginLeft: '4px' }}>oSQTH</span>
                    </div>
                  )
                }
              />

              <div className={classes.divider}>
                <TradeInfoItem
                  label="Value if ETH up 2x"
                  value={Number((squeethExposure * 4).toFixed(2)).toLocaleString()}
                  tooltip="The value of your position if ETH goes up 2x, not including funding"
                  frontUnit="$"
                />
                {/* if ETH down 50%, squeeth down 75%, so multiply amount by 0.25 to get what would remain  */}
                <TradeInfoItem
                  label="Value if ETH down 50%"
                  value={Number((squeethExposure * 0.25).toFixed(2)).toLocaleString()}
                  tooltip="The value of your position if ETH goes down 50%, not including funding"
                  frontUnit="$"
                />
                <div style={{ marginTop: '10px' }}>
                  <UniswapData
                    slippage={isNaN(Number(slippageAmount)) ? '0' : slippageAmount.toString()}
                    priceImpact={quote.priceImpact}
                    minReceived={quote.minimumAmountOut.toFixed(6)}
                    minReceivedUnit="oSQTH"
                  />
                </div>
              </div>
              <div className={classes.buttonDiv}>
                {!connected ? (
                  <PrimaryButton
                    variant="contained"
                    onClick={selectWallet}
                    className={classes.amountInput}
                    disabled={!!buyLoading}
                    style={{ width: '300px' }}
                  >
                    {'Connect Wallet'}
                  </PrimaryButton>
                ) : (
                  <PrimaryButton
                    variant={longOpenPriceImpactErrorState ? 'outlined' : 'contained'}
                    onClick={transact}
                    className={classes.amountInput}
                    disabled={!!buyLoading || !!openError || !!existingShortError}
                    style={
                      longOpenPriceImpactErrorState
                        ? { width: '300px', color: '#f5475c', backgroundColor: 'transparent', borderColor: '#f5475c' }
                        : { width: '300px' }
                    }
                  >
                    {buyLoading ? (
                      <CircularProgress color="primary" size="1.5rem" />
                    ) : longOpenPriceImpactErrorState ? (
                      'Buy Anyway'
                    ) : (
                      'Buy'
                    )}
                  </PrimaryButton>
                )}
                <Typography variant="caption" className={classes.caption} component="div">
                  Trades on Uniswap V3 🦄
                </Typography>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', margin: '20px 0' }}>
              <UniswapIframe />
            </div>
          )}
        </div>
      ) : (
        <div>
          <Confirmed confirmationMessage={`Bought ${quote.amountOut.toFixed(6)} Squeeth`} txnHash={txHash} />
          <div className={classes.buttonDiv}>
            <PrimaryButton
              variant="contained"
              onClick={() => setConfirmed(false)}
              className={classes.amountInput}
              style={{ width: '300px' }}
            >
              {'Close'}
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  )
}

const CloseLong: React.FC<BuyProps> = ({ balance, open, closeTitle, isLPage = false, activeStep = 0 }) => {
  const [sellLoading, setSellLoading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [txHash, setTxHash] = useState('')
  const [hasJustApprovedSqueeth, setHasJustApprovedSqueeth] = useState(false)

  const classes = useStyles()
  const { swapRouter, wSqueeth } = useAddresses()
  const wSqueethBal = useTokenBalance(wSqueeth, 5, WSQUEETH_DECIMALS)
  const { sell, getWSqueethPositionValue, getSellQuote, getSellQuoteForETH } = useSqueethPool()
  const {
    tradeAmount: amount,
    setTradeAmount: setAmount,
    quote,
    altTradeAmount,
    setAltTradeAmount,
    setTradeSuccess,
    slippageAmount,
  } = useTrade()
  const { allowance: squeethAllowance, approve: squeethApprove } = useUserAllowance(wSqueeth, swapRouter)
  const { selectWallet, connected } = useWallet()
  const ethPrice = useETHPrice()
  const { squeethAmount: shrtAmt } = useShortPositions()

  useEffect(() => {
    if (!open && wSqueethBal.lt(amount)) {
      setAmount(wSqueethBal)
    }
  }, [wSqueethBal, open])

  let openError: string | undefined
  let closeError: string | undefined
  let existingShortError: string | undefined
  let priceImpactWarning: string | undefined

  if (connected) {
    if (wSqueethBal.lt(amount)) {
      closeError = 'Insufficient oSQTH balance'
    }
    if (amount.gt(balance)) {
      openError = 'Insufficient ETH balance'
    }
    if (shrtAmt.gt(0)) {
      existingShortError = 'Close your short position to open a long'
    }
    if (new BigNumber(quote.priceImpact).gt(3)) {
      priceImpactWarning = 'High Price Impact'
    }
  }

  const longClosePriceImpactErrorState =
    priceImpactWarning && !closeError && !sellLoading && !wSqueethBal.isZero() && !shrtAmt.gt(0)

  const sellAndClose = useCallback(async () => {
    setSellLoading(true)
    try {
      if (squeethAllowance.lt(amount)) {
        await squeethApprove()
        setHasJustApprovedSqueeth(true)
      } else {
        const confirmedHash = await sell(amount)
        setConfirmed(true)
        setTxHash(confirmedHash.transactionHash)
        setTradeSuccess(true)
      }
    } catch (e) {
      console.log(e)
    }
    setSellLoading(false)
  }, [amount, sell, squeethAllowance, squeethApprove, wSqueethBal])

  const handleCloseDualInputUpdate = (v: number | string, currentInput: string) => {
    //If I'm inputting an amount of ETH I'd like to receive from selling my squeeth, use getSellQuoteForETH
    if (isNaN(+v) || +v === 0) v = 0
    if (currentInput === 'ETH') {
      setAltTradeAmount(new BigNumber(v))
      getSellQuoteForETH(new BigNumber(v)).then((val) => {
        setAmount(val.amountIn)
      })
    } else {
      //If I'm inputting an amount of squeeth I'd like to sell to receive ETH, use getSellQuote
      setAmount(new BigNumber(v))
      getSellQuote(new BigNumber(v)).then((val) => {
        setAltTradeAmount(val.amountOut)
      })
    }
  }

  return (
    <div>
      {!confirmed ? (
        <div>
          <div className={classes.settingsContainer}>
            <Typography variant="caption" className={classes.explainer} component="div">
              {closeTitle}
            </Typography>
            <span className={classes.settingsButton}>
              <TradeSettings />
            </span>
          </div>

          <div className={classes.thirdHeading} />
          <PrimaryInput
            value={amount.toNumber().toString()}
            onChange={(v) => handleCloseDualInputUpdate(v, 'oSQTH')}
            label="Amount"
            tooltip="Amount of wSqueeth you want to close"
            actionTxt="Max"
            onActionClicked={() => {
              setAmount(wSqueethBal)
              getSellQuote(new BigNumber(wSqueethBal)).then((val) => {
                setAltTradeAmount(val.amountOut)
              })
            }}
            unit="oSQTH"
            convertedValue={getWSqueethPositionValue(amount).toFixed(2).toLocaleString()}
            error={!!existingShortError || !!priceImpactWarning || !!closeError}
            hint={
              existingShortError ? (
                existingShortError
              ) : closeError ? (
                closeError
              ) : priceImpactWarning ? (
                priceImpactWarning
              ) : (
                <div className={classes.hint}>
                  <span className={classes.hintTextContainer}>
                    <span className={classes.hintTitleText}>Position</span> <span>{wSqueethBal.toFixed(6)}</span>
                  </span>
                  {quote.amountOut.gt(0) ? (
                    <>
                      <ArrowRightAltIcon className={classes.arrowIcon} />
                      <span>{wSqueethBal.minus(amount).toFixed(6)}</span>
                    </>
                  ) : null}{' '}
                  <span style={{ marginLeft: '4px' }}>oSQTH</span>
                </div>
              )
            }
          />
          <PrimaryInput
            value={altTradeAmount.toNumber().toString()}
            onChange={(v) => handleCloseDualInputUpdate(v, 'ETH')}
            label="Amount"
            tooltip="Amount of wSqueeth you want to close in eth"
            unit="ETH"
            convertedValue={altTradeAmount.times(ethPrice).toFixed(2).toLocaleString()}
            error={!!existingShortError || !!priceImpactWarning || !!closeError}
            hint={
              existingShortError ? (
                existingShortError
              ) : closeError ? (
                closeError
              ) : priceImpactWarning ? (
                priceImpactWarning
              ) : (
                <div className={classes.hint}>
                  <span>{`Balance ${balance}`}</span>
                  {amount.toNumber() ? (
                    <>
                      <ArrowRightAltIcon className={classes.arrowIcon} />
                      <span>{(balance + altTradeAmount.toNumber()).toFixed(6)}</span>
                    </>
                  ) : null}{' '}
                  <span style={{ marginLeft: '4px' }}>ETH</span>
                </div>
              )
            }
          />
          <div className={classes.divider}>
            <UniswapData
              slippage={isNaN(Number(slippageAmount)) ? '0' : slippageAmount.toString()}
              priceImpact={quote.priceImpact}
              minReceived={quote.minimumAmountOut.toFixed(4)}
              minReceivedUnit="ETH"
            />
          </div>
          <div className={classes.buttonDiv}>
            {!connected ? (
              <PrimaryButton
                variant="contained"
                onClick={selectWallet}
                className={classes.amountInput}
                disabled={!!sellLoading}
                style={{ width: '300px' }}
              >
                {'Connect Wallet'}
              </PrimaryButton>
            ) : (
              <PrimaryButton
                variant={longClosePriceImpactErrorState ? 'outlined' : 'contained'}
                onClick={sellAndClose}
                className={classes.amountInput}
                disabled={!!sellLoading || !!closeError || !!existingShortError || wSqueethBal.isZero()}
                style={
                  longClosePriceImpactErrorState
                    ? { width: '300px', color: '#f5475c', backgroundColor: 'transparent', borderColor: '#f5475c' }
                    : { width: '300px' }
                }
              >
                {sellLoading ? (
                  <CircularProgress color="primary" size="1.5rem" />
                ) : squeethAllowance.lt(amount) ? (
                  'Approve oSQTH (1/2)'
                ) : longClosePriceImpactErrorState ? (
                  'Sell Anyway'
                ) : hasJustApprovedSqueeth ? (
                  'Sell to close (2/2)'
                ) : (
                  'Sell to close'
                )}
              </PrimaryButton>
            )}
            <Typography variant="caption" className={classes.caption} component="div">
              Trades on Uniswap 🦄
            </Typography>
          </div>
        </div>
      ) : (
        <div>
          <Confirmed confirmationMessage={`Sold ${amount.toNumber()} Squeeth`} txnHash={txHash} />
          <div className={classes.buttonDiv}>
            <PrimaryButton
              variant="contained"
              onClick={() => setConfirmed(false)}
              className={classes.amountInput}
              style={{ width: '300px' }}
            >
              {'Close'}
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  )
}

type BuyProps = {
  balance: number
  open: boolean
  closeTitle: string
  isLPage?: boolean
  activeStep?: number
}

const Long: React.FC<BuyProps> = ({ balance, open, closeTitle, isLPage = false, activeStep = 0 }) => {
  return open ? (
    <OpenLong balance={balance} open={open} closeTitle={closeTitle} isLPage={isLPage} activeStep={activeStep} />
  ) : (
    <CloseLong balance={balance} open={open} closeTitle={closeTitle} isLPage={isLPage} activeStep={activeStep} />
  )
}

export default Long