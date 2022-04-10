import { ethers } from "hardhat"
import { expect } from "chai";
import { Contract, BigNumber, providers, constants } from "ethers";
import BigNumberJs from 'bignumber.js'

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { WETH9, MockErc20, ShortPowerPerp, Controller, Oracle, WPowerPerp, ControllerHelper, INonfungiblePositionManager} from "../../../typechain";
import { deployUniswapV3, deploySqueethCoreContracts, deployWETHAndDai, addWethDaiLiquidity, addSqueethLiquidity } from '../../setup'
import { one, oracleScaleFactor, getNow } from "../../utils"
import { convertCompilerOptionsFromJson } from "typescript";

BigNumberJs.set({EXPONENTIAL_AT: 30})

describe("Controller helper integration test", function () {
  const startingEthPrice = 3000
  const startingEthPrice1e18 = BigNumber.from(startingEthPrice).mul(one) // 3000 * 1e18
  const scaledStartingSqueethPrice1e18 = startingEthPrice1e18.div(oracleScaleFactor) // 0.3 * 1e18
  const scaledStartingSqueethPrice = startingEthPrice / oracleScaleFactor.toNumber() // 0.3


  let provider: providers.JsonRpcProvider;
  let owner: SignerWithAddress;
  let depositor: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let tester: SignerWithAddress
  let dai: MockErc20
  let weth: WETH9
  let positionManager: Contract
  let uniswapFactory: Contract
  let oracle: Oracle
  let controller: Controller
  let wSqueethPool: Contract
  let wSqueeth: WPowerPerp
  let ethDaiPool: Contract
  let controllerHelper: ControllerHelper
  let shortSqueeth: ShortPowerPerp
  let swapRouter: Contract
  let quoter: Contract

  this.beforeAll("Deploy uniswap protocol & setup uniswap pool", async() => {
    const accounts = await ethers.getSigners();
    const [_owner, _depositor, _feeRecipient, _tester ] = accounts;
    owner = _owner;
    depositor = _depositor;
    feeRecipient = _feeRecipient
    tester = _tester;
    provider = ethers.provider

    const { dai: daiToken, weth: wethToken } = await deployWETHAndDai()

    dai = daiToken
    weth = wethToken

    const uniDeployments = await deployUniswapV3(weth)
    positionManager = uniDeployments.positionManager
    uniswapFactory = uniDeployments.uniswapFactory
    swapRouter = uniDeployments.swapRouter
    quoter = uniDeployments.quoter


    // this will not deploy a new pool, only reuse old onces
    const squeethDeployments = await deploySqueethCoreContracts(
      weth,
      dai, 
      positionManager, 
      uniswapFactory,
      scaledStartingSqueethPrice,
      startingEthPrice
    )
    controller = squeethDeployments.controller
    wSqueeth = squeethDeployments.wsqueeth
    oracle = squeethDeployments.oracle
    shortSqueeth = squeethDeployments.shortSqueeth
    wSqueethPool = squeethDeployments.wsqueethEthPool
    ethDaiPool = squeethDeployments.ethDaiPool
    
    const ControllerHelperUtil = await ethers.getContractFactory("ControllerHelperUtil")
    const ControllerHelperUtilLib = (await ControllerHelperUtil.deploy());
    
    const ControllerHelperContract = await ethers.getContractFactory("ControllerHelper", {libraries: {ControllerHelperUtil: ControllerHelperUtilLib.address}});
    controllerHelper = (await ControllerHelperContract.deploy(controller.address, positionManager.address, uniswapFactory.address, constants.AddressZero)) as ControllerHelper;
  })
  
  this.beforeAll("Seed pool liquidity", async() => {
    // add liquidity

    await addWethDaiLiquidity(
      startingEthPrice,
      ethers.utils.parseUnits('100'), // eth amount
      owner.address,
      dai,
      weth,
      positionManager
    )
    await provider.send("evm_increaseTime", [600])
    await provider.send("evm_mine", [])

    await addSqueethLiquidity(
      scaledStartingSqueethPrice, 
      '1000000',
      '2000000', 
      owner.address, 
      wSqueeth, 
      weth, 
      positionManager, 
      controller
    )
    await provider.send("evm_increaseTime", [600])
    await provider.send("evm_mine", [])
  })

  describe("Mint short with flash deposit", async () => {
    it("flash mint", async () => {      
      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      await controller.connect(owner).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
      const swapParam = {
        tokenIn: wSqueeth.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
        amountIn: mintWSqueethAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }    
      await wSqueeth.connect(owner).approve(swapRouter.address, constants.MaxUint256)
      const ethAmountOut = await swapRouter.connect(owner).callStatic.exactInputSingle(swapParam)
      const vaultId = await shortSqueeth.nextId();
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const value = collateralAmount.sub(ethAmountOut.mul(one.sub(slippage)).div(one))
      const controllerBalanceBefore = await provider.getBalance(controller.address)
      const squeethBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      const vaultBefore = await controller.vaults(vaultId)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const ethToReceive = (mintWSqueethAmount.mul(squeethPrice).div(one)).mul(one.sub(slippage)).div(one)
      // console.log('first vault id ', vaultId.toString())
      const params = {
        vaultId: 0,
        collateralAmount: collateralAmount.toString(),
        wPowerPerpAmountToMint: mintWSqueethAmount.toString(),
        minToReceive: ethToReceive.toString(),
        wPowerPerpAmountToSell: BigNumber.from(0)
      }

      await controllerHelper.connect(depositor).flashswapSellLongWMint(params, {value: value});

      const controllerBalanceAfter = await provider.getBalance(controller.address)
      const squeethBalanceAfter = await wSqueeth.balanceOf(depositor.address)
      const vaultAfter = await controller.vaults(vaultId)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(controllerBalanceBefore.add(collateralAmount).eq(controllerBalanceAfter)).to.be.true
      expect(squeethBalanceBefore.eq(squeethBalanceAfter)).to.be.true
      expect(vaultBefore.collateralAmount.add(collateralAmount).eq(vaultAfter.collateralAmount)).to.be.true
      expect(vaultBefore.shortAmount.add(mintWSqueethAmount).eq(vaultAfter.shortAmount)).to.be.true
      expect(depositorEthBalanceAfter.gt(depositorEthBalanceBefore.sub(value))).to.be.true
    })

    it("flash mint sell 100% proceeds with zero additional eth", async () => {      
      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const controllerBalanceBefore = await provider.getBalance(controller.address)
      const squeethBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      const depositorBalanceInitial = await provider.getBalance(depositor.address)
      // console.log('depositorBalanceInitial.toString()',depositorBalanceInitial.toString())
      // Deposit enough collateral for 10 wSqueeth but don't mint anything
      await controller.connect(depositor).mintWPowerPerpAmount(0, 0, 0, {value: collateralAmount})
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      // console.log('depositorEthBalanceBefore.toString()',depositorEthBalanceBefore.toString())

      await wSqueeth.connect(depositor).approve(swapRouter.address, constants.MaxUint256)
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      await wSqueeth.connect(depositor).approve(swapRouter.address, constants.MaxUint256)
      // Get expected proceeds of sale of wSqeeth 
      // const depositorBalance1 = await provider.getBalance(depositor.address)
      // console.log('depositorBalance1.toString()', depositorBalance1.toString())


      const ethAmountOutFromSwap = await quoter.connect(tester).callStatic.quoteExactInputSingle(wSqueeth.address,
           weth.address,
           3000,
           mintWSqueethAmount,
           0)
      const depositorBalanceMid = await provider.getBalance(depositor.address)

      // console.log('Expected eth amountOut', ethAmountOutFromSwap.toString())
      // console.log('depositor vault ', vaultId.toString())
      // console.log('owner of vaultId', await shortSqueeth.ownerOf(vaultId.toString()));
      // console.log('depositor address', depositor.address.toString());
      // console.log('mintWSqueethAmount', mintWSqueethAmount.toString());
      const params = {
        vaultId: vaultId.toString(),
        collateralAmount: ethAmountOutFromSwap.toString(), // deposit 100% of proceeds of swap as collateral
        wPowerPerpAmountToMint: mintWSqueethAmount.toString(),
        minToReceive: BigNumber.from(0),
        wPowerPerpAmountToSell: BigNumber.from(0)
      }
      // flash mint with zero additional eth
      await controllerHelper.connect(depositor).flashswapSellLongWMint(params);

      const controllerBalanceAfter = await provider.getBalance(controller.address)
      const squeethBalanceAfter = await wSqueeth.balanceOf(depositor.address)
      const vaultAfter = await controller.vaults(vaultId)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)
      
      // console.log('vaultBefore.shortAmount', vaultBefore.shortAmount.toString());
      // console.log('ethAmountOutFromSwap', ethAmountOutFromSwap.toString());
      // console.log('collateralAmount', collateralAmount.toString());
      // console.log('controllerBalanceBefore', controllerBalanceBefore.toString());
      // console.log('controllerBalanceAfter', controllerBalanceAfter.toString());
      // console.log('vaultBefore.collateralAmount', vaultBefore.collateralAmount.toString());
      // console.log('vaultAfter.shortAmount', vaultAfter.shortAmount.toString());
      // console.log('vaultAfter.collateralAmount', vaultAfter.collateralAmount.toString());
      // console.log('depositorBalanceInitial.toString()',depositorBalanceInitial.toString())
      // console.log('depositorEthBalanceBefore.toString()', depositorEthBalanceBefore.toString());
      // console.log('depositorBalance1.toString()', depositorBalance1.toString());
      // console.log('depositorBalanceMid.toString()', depositorBalanceMid.toString());
      // console.log('depositorEthBalanceAfter.toString()', depositorEthBalanceAfter.toString());
      // console.log('squeethBalanceBefore.toString()', squeethBalanceBefore.toString());
      // console.log('squeethBalanceAfter.toString()', squeethBalanceAfter.toString());
      // controller increased by collateral
      //expect(controllerBalanceBefore.add(collateralAmount).eq(controllerBalanceAfter)).to.be.true
      // no long squeeth
      expect(squeethBalanceBefore.eq(squeethBalanceAfter)).to.be.true
      // 100% of sale proceeds added to collateral
      // console.log('test', (vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount)).div(ethAmountOutFromSwap).toString())
      // console.log('test', (vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount)).div(ethAmountOutFromSwap).eq(BigNumber.from(1)))
      expect(vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount).sub(ethAmountOutFromSwap).eq(BigNumber.from(0))).to.be.true
      // target short amount minted
      expect(vaultBefore.shortAmount.add(mintWSqueethAmount).eq(vaultAfter.shortAmount)).to.be.true
      // depositor balance reduced by collateral
      //expect(depositorEthBalanceAfter.eq(depositorEthBalanceBefore)).to.be.true
      //ßexpect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(remainingETHFromLp)).div(one).toString()) <= 0.01).to.be.true

      // console.log('depositorEthBalanceBefore.toString()', depositorEthBalanceBefore.toString());
      // console.log('depositorEthBalanceAfter.toString()', depositorEthBalanceAfter.toString());
      // const testDiff = depositorEthBalanceAfter.sub(depositorEthBalanceBefore)
      // console.log('testDiff', testDiff.toString())
    })

    it("flash mint sell 50% proceeds with 0 additional eth", async () => {      
      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const controllerBalanceBefore = await provider.getBalance(controller.address)
      const squeethBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      // Deposit enough collateral for 10 wSqueeth but don't mint anything
      await controller.connect(depositor).mintWPowerPerpAmount(0, 0, 0, {value: collateralAmount})
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      await wSqueeth.connect(depositor).approve(swapRouter.address, constants.MaxUint256)
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      await wSqueeth.connect(owner).approve(swapRouter.address, constants.MaxUint256)

      // Get expected proceeds of sale of wSqeeth 
      const ethAmountOutFromSwap = await quoter.connect(tester).callStatic.quoteExactInputSingle(wSqueeth.address,
           weth.address,
           3000,
           mintWSqueethAmount,
           0)

      // console.log('ethAmountOutFromSwap', ethAmountOutFromSwap.toString())
      // console.log('depositor vault ', vaultId.toString())
      // console.log('owner of vaultId', await shortSqueeth.ownerOf(vaultId.toString()));
      // console.log('depositor address', depositor.address.toString());
      // console.log('mintWSqueethAmount', mintWSqueethAmount.toString());
      const params = {
        vaultId: vaultId.toString(),
        collateralAmount: ethAmountOutFromSwap.div(2).toString(), // deposit 100% of proceeds of swap as collateral
        wPowerPerpAmountToMint: mintWSqueethAmount.toString(),
        minToReceive: BigNumber.from(0),
        wPowerPerpAmountToSell: BigNumber.from(0)
      }
      // flash mint with zero additional eth
      await controllerHelper.connect(depositor).flashswapSellLongWMint(params);

      const controllerBalanceAfter = await provider.getBalance(controller.address)
      const squeethBalanceAfter = await wSqueeth.balanceOf(depositor.address)
      const vaultAfter = await controller.vaults(vaultId)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)
      

      // console.log('vaultBefore.shortAmount', vaultBefore.shortAmount.toString());
      // console.log('ethAmountOutFromSwap', ethAmountOutFromSwap.toString());
      // console.log('collateralAmount', collateralAmount.toString());
      // console.log('controllerBalanceBefore', controllerBalanceBefore.toString());
      // console.log('controllerBalanceAfter', controllerBalanceAfter.toString());
      // console.log('vaultBefore.collateralAmount', vaultBefore.collateralAmount.toString());
      // console.log('vaultAfter.shortAmount', vaultAfter.shortAmount.toString());
      // console.log('vaultAfter.collateralAmount', vaultAfter.collateralAmount.toString());
      // console.log('depositorEthBalanceBefore.toString()', depositorEthBalanceBefore.toString());
      // console.log('depositorEthBalanceAfter.toString()', depositorEthBalanceAfter.toString());
      // console.log('squeethBalanceBefore.toString()', squeethBalanceBefore.toString());
      // console.log('squeethBalanceAfter.toString()', squeethBalanceAfter.toString());
      // controller increased by collateral
      //expect(controllerBalanceBefore.add(collateralAmount).eq(controllerBalanceAfter)).to.be.true
      // no long squeeth
      expect(squeethBalanceBefore.eq(squeethBalanceAfter)).to.be.true
      // 100% of sale proceeds added to collateral
      // console.log('test', (vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount)).div(ethAmountOutFromSwap).toString())
      // console.log('test', (vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount)).div(ethAmountOutFromSwap).eq(BigNumber.from(1)))
      expect(vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount).sub(ethAmountOutFromSwap.div(2)).eq(BigNumber.from(0))).to.be.true
      // target short amount minted
      expect(vaultBefore.shortAmount.add(mintWSqueethAmount).eq(vaultAfter.shortAmount)).to.be.true
      // depositor balance reduced by collateral
      //expect(depositorEthBalanceAfter.eq(depositorEthBalanceBefore)).to.be.true
      //ßexpect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(remainingETHFromLp)).div(one).toString()) <= 0.01).to.be.true

      // console.log('depositorEthBalanceBefore.toString()', depositorEthBalanceBefore.toString());
      // console.log('depositorEthBalanceAfter.toString()', depositorEthBalanceAfter.toString());
      // const testDiff = depositorEthBalanceAfter.sub(depositorEthBalanceBefore)
      // console.log('testDiff', testDiff.toString())

    })

    it("flash mint sell 0% proceeds with 0 additional eth", async () => {      
      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const controllerBalanceBefore = await provider.getBalance(controller.address)
      const squeethBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      // Deposit enough collateral for 10 wSqueeth but don't mint anything
      await controller.connect(depositor).mintWPowerPerpAmount(0, 0, 0, {value: collateralAmount})
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      await wSqueeth.connect(depositor).approve(swapRouter.address, constants.MaxUint256)
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      await wSqueeth.connect(owner).approve(swapRouter.address, constants.MaxUint256)
      // Get expected proceeds of sale of wSqeeth 
      const ethAmountOutFromSwap = await quoter.connect(tester).callStatic.quoteExactInputSingle(wSqueeth.address,
           weth.address,
           3000,
           mintWSqueethAmount,
           0)

      // console.log('ethAmountOutFromSwap', ethAmountOutFromSwap.toString())
      // console.log('depositor vault ', vaultId.toString())
      // console.log('owner of vaultId', await shortSqueeth.ownerOf(vaultId.toString()));
      // console.log('depositor address', depositor.address.toString());
      // console.log('mintWSqueethAmount', mintWSqueethAmount.toString());
      const params = {
        vaultId: vaultId.toString(),
        collateralAmount: BigNumber.from(0), // deposit 100% of proceeds of swap as collateral
        wPowerPerpAmountToMint: mintWSqueethAmount.toString(),
        minToReceive: BigNumber.from(0),
        wPowerPerpAmountToSell: BigNumber.from(0)
      }
      // flash mint with zero additional eth
      await controllerHelper.connect(depositor).flashswapSellLongWMint(params);

      const controllerBalanceAfter = await provider.getBalance(controller.address)
      const squeethBalanceAfter = await wSqueeth.balanceOf(depositor.address)
      const vaultAfter = await controller.vaults(vaultId)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)
      
      // console.log('vaultBefore.shortAmount', vaultBefore.shortAmount.toString());
      // console.log('ethAmountOutFromSwap', ethAmountOutFromSwap.toString());
      // console.log('collateralAmount', collateralAmount.toString());
      // console.log('controllerBalanceBefore', controllerBalanceBefore.toString());
      // console.log('controllerBalanceAfter', controllerBalanceAfter.toString());
      // console.log('vaultBefore.collateralAmount', vaultBefore.collateralAmount.toString());
      // console.log('vaultAfter.shortAmount', vaultAfter.shortAmount.toString());
      // console.log('vaultAfter.collateralAmount', vaultAfter.collateralAmount.toString());
      // console.log('depositorEthBalanceBefore.toString()', depositorEthBalanceBefore.toString());
      // console.log('depositorEthBalanceAfter.toString()', depositorEthBalanceAfter.toString());
      // console.log('squeethBalanceBefore.toString()', squeethBalanceBefore.toString());
      // console.log('squeethBalanceAfter.toString()', squeethBalanceAfter.toString());
      // controller increased by collateral
      //expect(controllerBalanceBefore.add(collateralAmount).eq(controllerBalanceAfter)).to.be.true
      // no long squeeth
      expect(squeethBalanceBefore.eq(squeethBalanceAfter)).to.be.true
      // 100% of sale proceeds added to collateral
      // console.log('test', (vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount)).div(ethAmountOutFromSwap).toString())
      // console.log('test', (vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount)).div(ethAmountOutFromSwap).eq(BigNumber.from(1)))
      expect(vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount).eq(BigNumber.from(0))).to.be.true
      // target short amount minted
      expect(vaultBefore.shortAmount.add(mintWSqueethAmount).eq(vaultAfter.shortAmount)).to.be.true
      // depositor balance reduced by collateral
      //expect(depositorEthBalanceAfter.eq(depositorEthBalanceBefore)).to.be.true
      //ßexpect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(remainingETHFromLp)).div(one).toString()) <= 0.01).to.be.true

      // console.log('depositorEthBalanceBefore.toString()', depositorEthBalanceBefore.toString());
      // console.log('depositorEthBalanceAfter.toString()', depositorEthBalanceAfter.toString());
      // const testDiff = depositorEthBalanceAfter.sub(depositorEthBalanceBefore)
      // console.log('testDiff', testDiff.toString())

    })


    it("flash close short position and buy long", async () => {
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      const vaultBefore = await controller.vaults(vaultId)
      // console.log('vaultBefore.collateralAmount', vaultBefore.collateralAmount.toString());
      // console.log('vaultBefore.shortAmount', vaultBefore.shortAmount.toString());
      const longBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const squeethToBuy = vaultBefore.collateralAmount.div(squeethPrice)
      const params = {
        vaultId,
        wPowerPerpAmountToBurn: vaultBefore.shortAmount.toString(),
        wPowerPerpAmountToBuy: squeethToBuy.toString(),
        collateralToWithdraw: vaultBefore.collateralAmount.toString(),
        maxToPay: vaultBefore.collateralAmount.toString()
      }
      await controllerHelper.connect(depositor).flashswapWBurnBuyLong(params);

      const vaultAfter = await controller.vaults(vaultId)
      const longBalanceAfter = await wSqueeth.balanceOf(depositor.address)

      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true
      expect(longBalanceAfter.sub(longBalanceBefore).eq(squeethToBuy)).to.be.true
    })

    it("full close position returning residual ETH in vault after cost to close to user ", async () => {

      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      // await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      const vaultBefore = await controller.vaults(vaultId)
      console.log('vaultBefore.collateralAmount', vaultBefore.collateralAmount.toString());
      console.log('vaultBefore.shortAmount', vaultBefore.shortAmount.toString());
      // const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      // const squeethToBuy = vaultBefore.collateralAmount.div(squeethPrice)
      // Get expected proceeds of sale of wSqeeth 
      console.log('vaultBefore.shortAmount.toString()',vaultBefore.shortAmount.toString())
      const ethAmountInToSwap = await quoter.connect(tester).callStatic.quoteExactInputSingle(wSqueeth.address,
        weth.address,
        3000,
        vaultBefore.shortAmount,
        0)
       console.log('ethAmountInToSwap', ethAmountInToSwap)
       console.log('maxToPay',vaultBefore.collateralAmount.sub(ethAmountInToSwap).toString())

      const params = {
        vaultId,
        wPowerPerpAmountToBurn: vaultBefore.shortAmount.toString(),
        wPowerPerpAmountToBuy: BigNumber.from(0),
        collateralToWithdraw: vaultBefore.collateralAmount.sub(ethAmountInToSwap).toString(),
        maxToPay: vaultBefore.collateralAmount.sub(ethAmountInToSwap).toString()
      }
      // ** May be good to have some explicit revert msgs here
      await controllerHelper.connect(depositor).flashswapWBurnBuyLong(params);

      const vaultAfter = await controller.vaults(vaultId)
      const longBalanceAfter = await wSqueeth.balanceOf(depositor.address)

      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true
      // expect(longBalanceAfter.sub(longBalanceBefore).eq(squeethToBuy)).to.be.true
    })

  })

  describe("Batch mint and LP", async () => {
    it("Batch mint and LP", async () => {
      const vaultId = (await shortSqueeth.nextId());

      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('15')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const collateralToLp = mintWSqueethAmount.mul(squeethPrice).div(one)
      const vaultBefore = await controller.vaults(vaultId)
      const tokenIndexBefore = await (positionManager as INonfungiblePositionManager).totalSupply();
      const params = {
        recipient: depositor.address,
        vaultId: 0,
        wPowerPerpAmount: mintWSqueethAmount,
        collateralToDeposit: collateralAmount,
        collateralToLp: collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        lowerTick: -887220,
        upperTick: 887220
      }

      await controllerHelper.connect(depositor).batchMintLp(params, {value: collateralAmount.add(collateralToLp)});

      const vaultAfter = await controller.vaults(vaultId)
      const tokenIndexAfter = await (positionManager as INonfungiblePositionManager).totalSupply();
      const tokenId = await (positionManager as INonfungiblePositionManager).tokenByIndex(tokenIndexAfter.sub(1));
      const ownerOfUniNFT = await (positionManager as INonfungiblePositionManager).ownerOf(tokenId); 
      const position = await (positionManager as INonfungiblePositionManager).positions(tokenId)

      expect(position.tickLower === -887220).to.be.true
      expect(position.tickUpper === 887220).to.be.true
      expect(ownerOfUniNFT === depositor.address).to.be.true
      expect(tokenIndexAfter.sub(tokenIndexBefore).eq(BigNumber.from(1))).to.be.true
      expect(vaultBefore.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultBefore.collateralAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(collateralAmount)).to.be.true
    })
  })

  describe("Sell long and flash mint short", async () => {
    before(async () => {
      let normFactor = await controller.normalizationFactor()
      let mintWSqueethAmount = ethers.utils.parseUnits('10')
      let mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      let ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      let scaledEthPrice = ethPrice.div(10000)
      let debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      let collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
      expect((await wSqueeth.balanceOf(depositor.address)).gte(mintWSqueethAmount)).to.be.true

      // minting mintWSqueethAmount to a tester address to get later how much should ETH to get for flahswap mintWSqueethAmount
      normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('20')
      mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      scaledEthPrice = ethPrice.div(10000)
      debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      await controller.connect(tester).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
      expect((await wSqueeth.balanceOf(tester.address)).gte(mintWSqueethAmount)).to.be.true
    })

    it("Sell long and flashswap mint short positon", async () => {
      const longBalance = await wSqueeth.balanceOf(depositor.address);
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const normFactor = await controller.normalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('20')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
     
      const swapParam = {
        tokenIn: wSqueeth.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
        amountIn: longBalance,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }    
      await wSqueeth.connect(depositor).approve(swapRouter.address, constants.MaxUint256)
      const ethAmountOutFromSwap = await swapRouter.connect(depositor).callStatic.exactInputSingle(swapParam)

      const flashswapParam = {
        tokenIn: wSqueeth.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
        amountIn: await wSqueeth.balanceOf(tester.address),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }    
      await wSqueeth.connect(tester).approve(swapRouter.address, constants.MaxUint256)
      const ethAmountOutFromFlashSwap = await swapRouter.connect(tester).callStatic.exactInputSingle(flashswapParam)

      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const value = collateralAmount.sub(ethAmountOutFromSwap.mul(one.sub(slippage)).div(one)).sub(ethAmountOutFromFlashSwap.mul(one.sub(slippage)).div(one))
      const params = {
        vaultId: 0,
        wPowerPerpAmountToMint: mintWSqueethAmount,
        collateralAmount: collateralAmount,
        wPowerPerpAmountToSell: longBalance,
        minToReceive: BigNumber.from(0)
      }
      await wSqueeth.connect(depositor).approve(controllerHelper.address, longBalance)
      await controllerHelper.connect(depositor).flashswapSellLongWMint(params, {value: value})

      const vaultAfter = await controller.vaults(vaultId)

      expect((await wSqueeth.balanceOf(depositor.address)).eq(BigNumber.from(0))).to.be.true;
      expect(vaultAfter.shortAmount.eq(mintWSqueethAmount)).to.be.true
    })



  })

  describe("Close position with user wallet NFT: LP wPowerPerp amount is less than vault short amount", async () => {
    let tokenId: BigNumber;
    let mintWSqueethAmount : BigNumber = ethers.utils.parseUnits('10')

    before("open short and LP" , async () => {
      const normFactor = await controller.normalizationFactor()
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const collateralToLp = mintWSqueethAmount.mul(squeethPrice).div(one)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address
  
      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : mintWSqueethAmount,
        amount1Desired: isWethToken0 ? mintWSqueethAmount : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }
  
      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      const tx = await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
      const receipt = await tx.wait();
      tokenId = (receipt.events?.find(event => event.event === 'IncreaseLiquidity'))?.args?.tokenId;  
    })

    it("Close position with NFT from user", async () => {
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const amount0Min = BigNumber.from(0);
      const amount1Min = BigNumber.from(0);

      const positionBefore = await (positionManager as INonfungiblePositionManager).positions(tokenId);

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(positionManager.address, tokenId); 
      const [amount0, amount1] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })
      const wPowerPerpAmountInLP = (isWethToken0) ? amount1 : amount0;
      const wethAmountInLP = (isWethToken0) ? amount0 : amount1;
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.add(slippage)).div(one);

      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address);
      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, tokenId); 
      await controllerHelper.connect(depositor).closeShortWithUserNft({
        vaultId, 
        tokenId,
        liquidity: positionBefore.liquidity,
        liquidityPercentage: BigNumber.from(1).mul(BigNumber.from(10).pow(18)),
        wPowerPerpAmountToBurn: mintWSqueethAmount, 
        collateralToWithdraw: vaultBefore.collateralAmount, 
        limitPriceEthPerPowerPerp,
        amount0Min: BigNumber.from(0), 
        amount1Min:BigNumber.from(0)
      })

      const positionAfter = await (positionManager as INonfungiblePositionManager).positions(tokenId);
      const vaultAfter = await controller.vaults(vaultId);
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(positionAfter.liquidity.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true

      if(wPowerPerpAmountInLP.lt(mintWSqueethAmount)) {
        const ethToBuySqueeth = (mintWSqueethAmount.sub(wPowerPerpAmountInLP)).mul(squeethPrice).div(one); 
        const remainingETHFromLp = wethAmountInLP.sub(ethToBuySqueeth);

        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(remainingETHFromLp)).div(one).toString()) <= 0.01).to.be.true
      }
      else if (wPowerPerpAmountInLP.gt(mintWSqueethAmount)) {
        const wPowerPerpAmountToSell = wPowerPerpAmountInLP.sub(mintWSqueethAmount);
        const ethToGet = wPowerPerpAmountToSell.mul(squeethPrice).div(one);

        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(ethToGet)).div(one).toString()) <= 0.01).to.be.true
      }
    })
  })

  describe("Close second position with user wallet NFT from 1st short: (remove 100% liquidity) LP wPowerPerp amount is more than vault short amount", async () => {
    let tokenId: BigNumber;
    let mintWSqueethAmount: BigNumber;

    before("open first short position and LP" , async () => {
      const normFactor = await controller.normalizationFactor()
      const mintWSqueethAmountToLp : BigNumber = ethers.utils.parseUnits('20')
      const mintRSqueethAmount = mintWSqueethAmountToLp.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const collateralToLp = mintWSqueethAmountToLp.mul(squeethPrice).div(one)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmountToLp, 0, {value: collateralAmount})

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address

      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : mintWSqueethAmountToLp,
        amount1Desired: isWethToken0 ? mintWSqueethAmountToLp : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }

      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      const tx = await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
      const receipt = await tx.wait();
      tokenId = (receipt.events?.find(event => event.event === 'IncreaseLiquidity'))?.args?.tokenId;  
    })

    before("open short amount less than amount in LP position" , async () => {
      const normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
    })

    it("Close position with NFT from user", async () => {
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const amount0Min = BigNumber.from(0);
      const amount1Min = BigNumber.from(0);
      const positionBefore = await (positionManager as INonfungiblePositionManager).positions(tokenId);

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(positionManager.address, tokenId); 
      const [amount0, amount1] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })
      const wPowerPerpAmountInLP = (isWethToken0) ? amount1 : amount0;
      const wethAmountInLP = (isWethToken0) ? amount0 : amount1;
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.sub(slippage)).div(one);

      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address);
      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, tokenId); 
      await controllerHelper.connect(depositor).closeShortWithUserNft({
        vaultId, 
        tokenId,
        liquidity: positionBefore.liquidity,
        liquidityPercentage: BigNumber.from(1).mul(BigNumber.from(10).pow(18)),
        wPowerPerpAmountToBurn: mintWSqueethAmount, 
        collateralToWithdraw: vaultBefore.collateralAmount, 
        limitPriceEthPerPowerPerp, 
        amount0Min: BigNumber.from(0), 
        amount1Min:BigNumber.from(0)
      })

      const positionAfter = await (positionManager as INonfungiblePositionManager).positions(tokenId);
      const vaultAfter = await controller.vaults(vaultId);
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(positionAfter.liquidity.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true

      if(wPowerPerpAmountInLP.lt(mintWSqueethAmount)) {
        const ethToBuySqueeth = (mintWSqueethAmount.sub(wPowerPerpAmountInLP)).mul(squeethPrice).div(one); 
        const remainingETHFromLp = wethAmountInLP.sub(ethToBuySqueeth);

        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(remainingETHFromLp)).div(one).toString()) <= 0.01).to.be.true
      }
      else if (wPowerPerpAmountInLP.gt(mintWSqueethAmount)) {
        const wPowerPerpAmountToSell = wPowerPerpAmountInLP.sub(mintWSqueethAmount);
        const ethToGet = wPowerPerpAmountToSell.mul(squeethPrice).div(one);

        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(ethToGet).add(wethAmountInLP)).div(one).toString()) <= 0.01).to.be.true
      }
    })
  })

  describe("Close second position with user wallet NFT from 1st short: (remove 60% liquidity) LP wPowerPerp amount is more than vault short amount", async () => {
    let tokenId: BigNumber;
    let mintWSqueethAmount: BigNumber;

    before("open first short position and LP" , async () => {
      const normFactor = await controller.normalizationFactor()
      const mintWSqueethAmountToLp : BigNumber = ethers.utils.parseUnits('20')
      const mintRSqueethAmount = mintWSqueethAmountToLp.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const collateralToLp = mintWSqueethAmountToLp.mul(squeethPrice).div(one)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmountToLp, 0, {value: collateralAmount})

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address

      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : mintWSqueethAmountToLp,
        amount1Desired: isWethToken0 ? mintWSqueethAmountToLp : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }

      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      const tx = await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
      const receipt = await tx.wait();
      tokenId = (receipt.events?.find(event => event.event === 'IncreaseLiquidity'))?.args?.tokenId;  
    })

    before("open short amount less than amount in LP position" , async () => {
      const normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
    })

    it("Close position with NFT from user", async () => {
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const amount0Min = BigNumber.from(0);
      const amount1Min = BigNumber.from(0);
      const positionBefore = await (positionManager as INonfungiblePositionManager).positions(tokenId);

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(positionManager.address, tokenId); 
      const [amount0, amount1] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.sub(slippage)).div(one);

      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address);
      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, tokenId); 
      await controllerHelper.connect(depositor).closeShortWithUserNft({
        vaultId, 
        tokenId,
        liquidity: positionBefore.liquidity,
        liquidityPercentage: BigNumber.from(6).mul(BigNumber.from(10).pow(17)),
        wPowerPerpAmountToBurn: mintWSqueethAmount, 
        collateralToWithdraw: vaultBefore.collateralAmount, 
        limitPriceEthPerPowerPerp, 
        amount0Min: BigNumber.from(0), 
        amount1Min:BigNumber.from(0)
      })

      const positionAfter = await (positionManager as INonfungiblePositionManager).positions(tokenId);
      const vaultAfter = await controller.vaults(vaultId);

      expect(positionAfter.liquidity.sub(positionBefore.liquidity.div(2)).lte(1)).to.be.true
      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true
    })
  })

  describe("Withdraw to ETH", async () => {
    let collateralToLp: BigNumber;
    let mintWSqueethAmount: BigNumber;

    before("open position and LP", async () => {
      const normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('35')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      collateralToLp = mintWSqueethAmount.mul(squeethPrice).div(one)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address
  
      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : mintWSqueethAmount,
        amount1Desired: isWethToken0 ? mintWSqueethAmount : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }
  
      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
    })

    it("sell all to ETH", async () => {
      // get expeceted ETH out from selling
      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      await controller.connect(owner).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
      const swapParam = {
        tokenIn: wSqueeth.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
        amountIn: mintWSqueethAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }    
      await wSqueeth.connect(owner).approve(swapRouter.address, constants.MaxUint256)
      const ethAmountOut = await swapRouter.connect(owner).callStatic.exactInputSingle(swapParam)

      const tokenIndexAfter = await (positionManager as INonfungiblePositionManager).totalSupply();
      const tokenId = await (positionManager as INonfungiblePositionManager).tokenByIndex(tokenIndexAfter.sub(1));
      const positionBefore = await (positionManager as INonfungiblePositionManager).positions(tokenId);
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.sub(slippage)).div(one);
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      const params = {
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: 0,
        amount1Min: 0,
        limitPriceEthPerPowerPerp: limitPriceEthPerPowerPerp
      }

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, tokenId);
      await controllerHelper.connect(depositor).sellAll(params);

      const depositorEthBalanceAfter= await provider.getBalance(depositor.address)

      expect(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(collateralToLp.add(ethAmountOut)).lte(BigNumber.from(10).pow(15))).to.be.true
    })
  })

  describe("Rebalance LP through trading amounts", async () => {
    let collateralToLp: BigNumber;
    let mintWSqueethAmount: BigNumber;

    before("open position and LP", async () => {
      const normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('35')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      collateralToLp = mintWSqueethAmount.mul(squeethPrice).div(one)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address
  
      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : mintWSqueethAmount,
        amount1Desired: isWethToken0 ? mintWSqueethAmount : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }
  
      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
    })

    it("rebalance to decrease WETH amount and LP only oSQTH", async () => {
      let tokenIndexAfter = await (positionManager as INonfungiblePositionManager).totalSupply();
      const oldTokenId = await (positionManager as INonfungiblePositionManager).tokenByIndex(tokenIndexAfter.sub(1));
      const oldPosition = await (positionManager as INonfungiblePositionManager).positions(oldTokenId);
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.sub(slippage)).div(one);

      const params = {
        tokenId: oldTokenId,
        ethAmountToLp: BigNumber.from(0),
        liquidity: oldPosition.liquidity,
        wPowerPerpAmountDesired: ethers.utils.parseUnits('20'),
        wethAmountDesired: ethers.utils.parseUnits('12'),
        amount0DesiredMin: BigNumber.from(0),
        amount1DesiredMin: BigNumber.from(0),
        limitPriceEthPerPowerPerp,
        amount0Min: BigNumber.from(0),
        amount1Min: BigNumber.from(0),
        lowerTick: -887220,
        upperTick: 887220,
        rebalanceToken0: false,
        rebalanceToken1: false
      }

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, oldTokenId);
      await controllerHelper.connect(depositor).rebalanceWithoutVault(params);

      tokenIndexAfter = await (positionManager as INonfungiblePositionManager).totalSupply();
      const newTokenId = await (positionManager as INonfungiblePositionManager).tokenByIndex(tokenIndexAfter.sub(1));
      const newPosition = await (positionManager as INonfungiblePositionManager).positions(newTokenId);
      const ownerOfUniNFT = await (positionManager as INonfungiblePositionManager).ownerOf(newTokenId); 

      const [amount0, amount1] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: newTokenId,
        liquidity: newPosition.liquidity,
        amount0Min: BigNumber.from(0),
        amount1Min: BigNumber.from(0),
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })

      console.log("amount0", amount0.toString())
      console.log("amount1", amount1.toString())

      expect(ownerOfUniNFT === depositor.address).to.be.true;
    })
  })
})