// mainnet fork tests
// in 1 terminal: npx hardhat node --fork https://mainnet.infura.io/v3/infura_key --fork-block-number 14345140 --no-deploy --network hardhat
// in 2 terminal: MAINNET_FORK=true npx hardhat test ./test/e2e/periphery/controller-helper.ts
import { ethers, network} from "hardhat"
import { expect } from "chai";
import { Contract, BigNumber, providers } from "ethers";
import BigNumberJs from 'bignumber.js'

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { WETH9, MockErc20, ShortPowerPerp, Controller, Oracle, WPowerPerp, ControllerHelper, INonfungiblePositionManager} from "../../../typechain";
import { deployUniswapV3, deploySqueethCoreContracts, deployWETHAndDai, addWethDaiLiquidity, addSqueethLiquidity } from '../../setup'
import { isSimilar, wmul, wdiv, one, oracleScaleFactor, getNow } from "../../utils"
import { JsonRpcSigner } from "@ethersproject/providers";

import {
  abi as POSITION_MANAGER_ABI,
  bytecode as POSITION_MANAGER_BYTECODE,
} from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import {
  abi as FACTORY_ABI,
  bytecode as FACTORY_BYTECODE,
} from '@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json'
import {
  abi as ROUTER_ABI,
  bytecode as ROUTER_BYTECODE,
} from '@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json'
import {
  abi as POOL_ABI,
  bytecode as POOL_BYTECODE,
} from '@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json'

BigNumberJs.set({EXPONENTIAL_AT: 30})

const impersonateAddress = async (address: string) => {
  const hre = require('hardhat');
  await hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [address],
  });
  let signer: any;
  signer = await ethers.provider.getSigner(address);
  signer.address = signer._address;
  signer._signer = signer;
  return signer;
};

describe("ControllerHelper: mainnet fork", function () {
  if (!process.env.MAINNET_FORK) return;

  // const startingEthPrice = 3000
  // const startingEthPrice1e18 = BigNumber.from(startingEthPrice).mul(one) // 3000 * 1e18
  // const scaledStartingSqueethPrice1e18 = startingEthPrice1e18.div(oracleScaleFactor) // 0.3 * 1e18
  // const scaledStartingSqueethPrice = startingEthPrice / oracleScaleFactor.toNumber() // 0.3


  let provider: providers.JsonRpcProvider;
  let owner: SignerWithAddress;
  let depositor: SignerWithAddress;
  // let depositor: JsonRpcSigner
  let feeRecipient: SignerWithAddress;
  let usdc: Contract
  let weth: Contract
  let positionManager: Contract
  let uniswapFactory: Contract
  let uniswapRouter: Contract
  let oracle: Oracle
  let controller: Controller
  let wSqueethPool: Contract
  let wSqueeth: WPowerPerp
  let ethUsdcPool: Contract
  let controllerHelper: ControllerHelper
  let shortSqueeth: ShortPowerPerp
  let swapRouter: string

  this.beforeAll("Setup mainnet fork contracts", async () => {
    depositor = await impersonateAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");

    // const usdcContract = await ethers.getContractFactory("MockErc20")
    usdc = await ethers.getContractAt("MockErc20", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
    // const wethContract = await ethers.getContractFactory("WETH9")
    // weth = await wethContract.attach("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")
    weth = await ethers.getContractAt("WETH9", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");

    positionManager = await ethers.getContractAt(POSITION_MANAGER_ABI, "0xC36442b4a4522E871399CD717aBDD847Ab11FE88");
    uniswapFactory = await ethers.getContractAt(FACTORY_ABI, "0x1F98431c8aD98523631AE4a59f267346ea31F984");
    // swapRouter = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"
    uniswapRouter = await ethers.getContractAt(ROUTER_ABI, "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45");

    controller = (await ethers.getContractAt("Controller", "0x64187ae08781B09368e6253F9E94951243A493D5")) as Controller
    wSqueeth = (await ethers.getContractAt("WPowerPerp", "0xf1B99e3E573A1a9C5E6B2Ce818b617F0E664E86B")) as WPowerPerp
    oracle = (await ethers.getContractAt("Oracle", "0x65D66c76447ccB45dAf1e8044e918fA786A483A1")) as Oracle
    shortSqueeth = (await ethers.getContractAt("ShortPowerPerp", "0xa653e22A963ff0026292Cc8B67941c0ba7863a38")) as ShortPowerPerp
    wSqueethPool = await ethers.getContractAt(POOL_ABI, "0x82c427AdFDf2d245Ec51D8046b41c4ee87F0d29C")
    // ethDaiPool = await ethers.getContractAt("MockErc20", "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8")
    ethUsdcPool = await ethers.getContractAt(POOL_ABI, "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8");

    // await controller.connect(owner).setFeeRecipient(feeRecipient.address);
    // await controller.connect(owner).setFeeRate(0)
    
    const TickMath = await ethers.getContractFactory("TickMathExternal")
    const TickMathLibrary = (await TickMath.deploy());
    const SqrtPriceExternal = await ethers.getContractFactory("SqrtPriceMathPartial")
    const SqrtPriceExternalLibrary = (await SqrtPriceExternal.deploy());  
    const ControllerHelperLib = await ethers.getContractFactory("ControllerHelperLib")
    const controllerHelperLib = (await ControllerHelperLib.deploy());  
    const ControllerHelperContract = await ethers.getContractFactory("ControllerHelper", {libraries: {TickMathExternal: TickMathLibrary.address, SqrtPriceMathPartial: SqrtPriceExternalLibrary.address}});
    controllerHelper = (await ControllerHelperContract.deploy(controller.address, oracle.address, shortSqueeth.address, "0x82c427AdFDf2d245Ec51D8046b41c4ee87F0d29C", wSqueeth.address, weth.address, uniswapRouter.address, positionManager.address, uniswapFactory.address, "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5")) as ControllerHelper;
  })

  describe("Flash mint short position, LP and use LP as collateral", async () => {
    it("open short, mint, LP, deposit LP NFT and withdraw ETH collateral", async ()=> {
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const normFactor = await controller.normalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('30')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethUsdcPool.address, weth.address, usdc.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralToMint = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const collateralToLp = mintWSqueethAmount.mul(squeethPrice).div(one)
      const flashloanWMintDepositNftParams = {
        vaultId: 0,
        wPowerPerpAmount: mintWSqueethAmount.toString(),
        collateralToMint: collateralToMint.toString(),
        collateralToLp: collateralToLp.toString(),
        collateralToWithdraw: 0,
        amount0Min: 0,
        amount1Min: 0,
        lowerTick: -887220,
        upperTick: 887220
      }
      const vaultBefore = await controller.vaults(vaultId)

      await controllerHelper.connect(depositor).flashloanWMintDepositNft(flashloanWMintDepositNftParams, {value: collateralToLp.add(ethers.utils.parseUnits('1'))})
    })
  })
})