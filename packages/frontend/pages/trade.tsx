import { Accordion, AccordionDetails, AccordionSummary, Grid, Tooltip } from '@material-ui/core'
import Card from '@material-ui/core/Card'
import { createStyles, makeStyles } from '@material-ui/core/styles'
import Typography from '@material-ui/core/Typography'
import ExpandMoreIcon from '@material-ui/icons/ExpandMore'
import InfoIcon from '@material-ui/icons/InfoOutlined'
import { useEffect, useState } from 'react'

import { LongChart } from '../src/components/Charts/LongChart'
import LongSqueethPayoff from '../src/components/Charts/LongSqueethPayoff'
import ShortSqueethPayoff from '../src/components/Charts/ShortSqueethPayoff'
import { VaultChart } from '../src/components/Charts/VaultChart'
import Nav from '../src/components/Nav'
import PositionCard from '../src/components/PositionCard'
import { SqueethTab, SqueethTabs } from '../src/components/Tabs'
import Trade from '../src/components/Trade'
import TradeInfoItem from '../src/components/Trade/TradeInfoItem'
import { Vaults } from '../src/constants'
import { TradeProvider, useTrade } from '../src/context/trade'
import { useWorldContext } from '../src/context/world'
import { useController } from '../src/hooks/contracts/useController'
import { useETHPrice } from '../src/hooks/useETHPrice'
import { useETHPriceCharts } from '../src/hooks/useETHPriceCharts'
import { TradeType } from '../src/types'
import { toTokenAmount } from '../src/utils/calculations'

const useStyles = makeStyles((theme) =>
  createStyles({
    header: {
      color: theme.palette.primary.main,
    },
    mainSection: {
      width: '50vw',
    },
    grid: {
      padding: theme.spacing(4, 0),
      paddingBottom: theme.spacing(5),
    },
    mainGrid: {
      maxWidth: '50%',
    },
    ticketGrid: {
      maxWidth: '350px',
    },
    subHeading: {
      color: theme.palette.text.secondary,
    },
    thirdHeading: {
      marginTop: theme.spacing(2),
    },
    buyCard: {
      marginLeft: theme.spacing(2),
      width: '400px',
    },
    cardTitle: {
      color: theme.palette.primary.main,
      marginTop: theme.spacing(4),
    },
    cardSubTxt: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
    },
    payoff: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
      marginTop: theme.spacing(2),
    },
    cardDetail: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
      marginTop: theme.spacing(4),
    },
    cardDetail1: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
      marginTop: theme.spacing(4),
      fontFamily: 'Open Sans',
    },
    amountInput: {
      marginTop: theme.spacing(4),
    },
    innerCard: {
      textAlign: 'center',
      paddingBottom: theme.spacing(4),
      background: theme.palette.background.lightStone,
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
    squeethInfo: {
      display: 'flex',
      marginTop: theme.spacing(4),
    },
    squeethInfoSubGroup: {
      display: 'flex',
      marginBottom: theme.spacing(8),
    },
    subGroupHeader: {
      marginBottom: theme.spacing(1),
    },
    infoIcon: {
      fontSize: '14px',
      marginLeft: theme.spacing(0.5),
    },
    infoItem: {
      marginRight: theme.spacing(4),
    },
    infoLabel: {
      display: 'flex',
      alignItems: 'center',
    },
    position: {
      display: 'flex',
      marginTop: theme.spacing(1),
    },
    positionToken: {
      fontSize: '16px',
      fontWeight: 600,
      marginRight: theme.spacing(4),
    },
    positionUSD: {
      fontSize: '16px',
      marginRight: theme.spacing(4),
    },
    subNavTabs: {
      marginTop: theme.spacing(4),
    },
    green: {
      color: theme.palette.success.main,
      marginRight: theme.spacing(4),
      fontSize: '16px',
    },
    red: {
      color: theme.palette.error.main,
      marginRight: theme.spacing(4),
      fontSize: '16px',
    },
    pi: {
      marginLeft: theme.spacing(2),
    },
    container: {
      // border: `1px solid ${theme.palette.background.stone}`,
      borderRadius: theme.spacing(1),
    },
    accordionRoot: {
      backgroundColor: 'transparent',
      // borderRadius: theme.spacing(4),
      boxShadow: 'none',
      padding: theme.spacing(0),
    },
    accordionExpanded: {
      minHeight: '0px',
    },
    detailsRoot: {
      padding: theme.spacing(0, 2, 2, 2),
    },
  }),
)

function TradePage() {
  const classes = useStyles()
  const [cost, setCost] = useState(0)
  const [squeethExposure, setSqueethExposure] = useState(0)
  const [customLong, setCustomLong] = useState(0)
  const ethPrice = useETHPrice()
  const { fundingPerDay, mark, index } = useController()

  const { volMultiplier: globalVolMultiplier, collatRatio } = useWorldContext()
  const { setVolMultiplier } = useETHPriceCharts(1, globalVolMultiplier)
  const { tradeType, setTradeType } = useTrade()
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setVolMultiplier(globalVolMultiplier)
  }, [globalVolMultiplier])

  const SqueethInfo = () => {
    return (
      <div className={classes.squeethInfo}>
        <div>
          <div className={classes.squeethInfoSubGroup}>
            <div className={classes.infoItem}>
              <Typography color="textSecondary" variant="body2">
                ETH Price
              </Typography>
              <Typography>${ethPrice.toNumber().toLocaleString()}</Typography>
            </div>

            <div className={classes.infoItem}>
              <div className={classes.infoLabel}>
                <Typography color="textSecondary" variant="body2">
                  Implied 24h Funding
                </Typography>
                <Tooltip
                  title={'Estimated amount of funding paid in next 24 hours. Funding will happen out of your position.'}
                >
                  <InfoIcon fontSize="small" className={classes.infoIcon} />
                </Tooltip>
              </div>
              <Typography>{(fundingPerDay * 100).toFixed(2)}%</Typography>
            </div>

            <div className={classes.infoItem}>
              <div className={classes.infoLabel}>
                <Typography color="textSecondary" variant="body2">
                  Funding Frequency
                </Typography>
                <Tooltip title={'Funding happens every time the contract is touched'}>
                  <InfoIcon fontSize="small" className={classes.infoIcon} />
                </Tooltip>
              </div>
              <Typography>Variable</Typography>
            </div>
          </div>
        </div>

        <div>
          <div className={classes.squeethInfoSubGroup}>
            <div className={classes.container}>
              <Accordion
                classes={{ root: classes.accordionRoot, expanded: classes.accordionExpanded }}
                square={false}
                onChange={(_, e) => setExpanded(e)}
                expanded={expanded}
              >
                <AccordionSummary aria-controls="panel1a-content" id="panel1a-header">
                  <Typography color="textSecondary" variant="body2">
                    Advanced Details
                  </Typography>
                  <ExpandMoreIcon />
                </AccordionSummary>
                <AccordionDetails classes={{ root: classes.detailsRoot }}>
                  <div style={{ width: '100%' }}>
                    <TradeInfoItem
                      label="Index Price"
                      value={Number(toTokenAmount(index, 18).toFixed(2)).toLocaleString()}
                      frontUnit="$"
                    />
                    <TradeInfoItem
                      label="Mark Price"
                      value={Number(toTokenAmount(mark, 18).toFixed(2)).toLocaleString()}
                      frontUnit="$"
                    />
                  </div>
                </AccordionDetails>
              </Accordion>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <Nav />
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <SqueethTabs
          value={tradeType}
          onChange={(evt, val) => setTradeType(val)}
          aria-label="Sub nav tabs"
          className={classes.subNavTabs}
        >
          <SqueethTab label="Long" />
          <SqueethTab label="Short" />
        </SqueethTabs>
      </div>

      {tradeType === TradeType.LONG ? (
        //long side
        <Grid container className={classes.grid}>
          <Grid item xs={1} />
          <Grid item xs={7} className={classes.mainGrid}>
            <Typography variant="h5">Long Squeeth - ETH&sup2; Position</Typography>
            <Typography variant="body1" color="textSecondary">
              Perpetual leverage without liquidations
            </Typography>
            <SqueethInfo />
            <PositionCard />
            <Typography className={classes.cardTitle} variant="h6">
              Historical Predicted Performance
            </Typography>
            <div className={classes.amountInput}>
              <LongChart />
            </div>
            <Typography className={classes.cardTitle} variant="h6">
              What is squeeth?
            </Typography>
            <Typography variant="body2" className={classes.cardDetail}>
              Long squeeth (ETH&sup2;) gives you a leveraged position with unlimited upside, protected downside, and no
              liquidations. Compared to a 2x leveraged position, you make more when ETH goes up and lose less when ETH
              goes down. Eg. If ETH goes up 5x, squeeth goes up 25x. You pay a funding rate for this position. Enter the
              position by purchasing an ERC20 token.{' '}
              <a
                className={classes.header}
                href="https://opynopyn.notion.site/Squeeth-FAQ-4b6a054ab011454cbbd60cb3ee23a37c"
              >
                {' '}
                Learn more.{' '}
              </a>
            </Typography>
            <Typography className={classes.cardTitle} variant="h6">
              Risks
            </Typography>
            <Typography variant="body2" className={classes.cardDetail1}>
              Funding is paid out of your position, meaning you sell a small amount of squeeth at funding, reducing your
              position size. Holding the position for a long period of time without upward movements in ETH can lose
              considerable funds to funding payments.
              <br /> <br />
              Squeeth smart contracts are currently unaudited. This is experimental technology and we encourage caution
              only risking funds you can afford to lose.
            </Typography>
          </Grid>
          <Grid item xs={1} />
          <Grid item xs={4} className={classes.ticketGrid}>
            <Card className={classes.innerCard}>
              <Trade />
            </Card>
            <Typography className={classes.thirdHeading} variant="h6">
              Payoff
            </Typography>
            <LongSqueethPayoff ethPrice={ethPrice.toNumber()} />
          </Grid>
        </Grid>
      ) : (
        //short side
        <Grid container className={classes.grid}>
          <Grid item xs={1} />
          <Grid item xs={7} className={classes.mainGrid}>
            <Typography variant="h5">Short Squeeth - short ETH&sup2; Position</Typography>
            <Typography variant="body1" color="textSecondary">
              Earn funding for selling ETH&sup2;
            </Typography>
            <SqueethInfo />
            <PositionCard />
            <Typography className={classes.cardTitle} variant="h6">
              Historical Predicted Performance
            </Typography>
            <div className={classes.amountInput}>
              <VaultChart vault={Vaults.Short} longAmount={0} showPercentage={false} setCustomLong={setCustomLong} />
            </div>
            <Typography className={classes.cardTitle} variant="h6">
              What is short squeeth?
            </Typography>
            <Typography variant="body2" className={classes.cardDetail}>
              Short squeeth (ETH&sup2;) is short an ETH&sup2; position. You earn a funding rate for taking on this
              position. You enter the position by putting down collateral, minting, and selling squeeth. If you become
              undercollateralized, you could be liquidated.{' '}
              <a
                className={classes.header}
                href="https://opynopyn.notion.site/Squeeth-FAQ-4b6a054ab011454cbbd60cb3ee23a37c"
              >
                {' '}
                Learn more.{' '}
              </a>
            </Typography>
            <Typography className={classes.cardTitle} variant="h6">
              Risks
            </Typography>
            <Typography variant="body2" className={classes.cardDetail}>
              If you fall below the minimum collateralization threshold (150%), you are at risk of liquidation. If ETH
              moves approximately 6% in either direction, you are unprofitable.
              <br /> <br />
              Squeeth smart contracts are currently unaudited. This is experimental technology and we encourage caution
              only risking funds you can afford to lose.
            </Typography>
          </Grid>
          <Grid item xs={1} />
          <Grid item xs={3} className={classes.ticketGrid}>
            <Card className={classes.innerCard}>
              <Trade />
            </Card>
            <Typography className={classes.thirdHeading} variant="h6">
              Payoff
            </Typography>
            <ShortSqueethPayoff ethPrice={ethPrice.toNumber()} collatRatio={collatRatio} />
          </Grid>
        </Grid>
      )}
    </div>
  )
}

export default function App() {
  return (
    <TradeProvider>
      <TradePage />
    </TradeProvider>
  )
}