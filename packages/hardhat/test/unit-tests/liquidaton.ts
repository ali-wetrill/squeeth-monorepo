import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";
import { ethers } from "hardhat"
import { expect } from "chai";
import { BigNumber, providers } from "ethers";
import { Controller, MockWSqueeth, MockVaultNFTManager, MockOracle, MockUniswapV3Pool, MockErc20 } from "../../typechain";
import { isSimilar } from '../utils'

const squeethETHPrice = ethers.utils.parseUnits('3010')
const ethUSDPrice = ethers.utils.parseUnits('3000')


describe("Controller: liquidation unit test", function () {
  let squeeth: MockWSqueeth;
  let shortNFT: MockVaultNFTManager;
  let controller: Controller;
  let squeethEthPool: MockUniswapV3Pool;
  let ethUSDPool: MockUniswapV3Pool;
  let oracle: MockOracle;
  let weth: MockErc20;
  let usdc: MockErc20;
  let provider: providers.JsonRpcProvider;
  let seller1: SignerWithAddress
  let liquidator: SignerWithAddress
  let random: SignerWithAddress

  this.beforeAll("Prepare accounts", async() => {
    const accounts = await ethers.getSigners();
    const [_seller1, _liquidator, _random] = accounts;
    seller1 = _seller1
    liquidator = _liquidator
    random = _random
    provider = ethers.provider
  })

  this.beforeAll("Setup environment", async () => {
    const MockSQUContract = await ethers.getContractFactory("MockWSqueeth");
    squeeth = (await MockSQUContract.deploy()) as MockWSqueeth;

    const NFTContract = await ethers.getContractFactory("MockVaultNFTManager");
    shortNFT = (await NFTContract.deploy()) as MockVaultNFTManager;

    const OracleContract = await ethers.getContractFactory("MockOracle");
    oracle = (await OracleContract.deploy()) as MockOracle;

    const MockErc20Contract = await ethers.getContractFactory("MockErc20");
    weth = (await MockErc20Contract.deploy("WETH", "WETH")) as MockErc20;
    usdc = (await MockErc20Contract.deploy("USDC", "USDC")) as MockErc20;

    const MockUniswapV3PoolContract = await ethers.getContractFactory("MockUniswapV3Pool");
    squeethEthPool = (await MockUniswapV3PoolContract.deploy()) as MockUniswapV3Pool;
    ethUSDPool = (await MockUniswapV3PoolContract.deploy()) as MockUniswapV3Pool;

    await squeethEthPool.setPoolTokens(weth.address, squeeth.address);
    await ethUSDPool.setPoolTokens(weth.address, usdc.address);


    await oracle.connect(random).setPrice(squeethEthPool.address, "1" , squeethETHPrice) // eth per 1 squeeth
    await oracle.connect(random).setPrice(ethUSDPool.address, "1" , ethUSDPrice)  // usdc per 1 eth
  });

  describe("Deployment", async () => {
    it("Deployment", async function () {
      const ControllerContract = await ethers.getContractFactory("Controller");
      controller = (await ControllerContract.deploy()) as Controller;
      await controller.init(oracle.address, shortNFT.address, squeeth.address, weth.address, usdc.address, ethUSDPool.address, squeethEthPool.address);
      const squeethAddr = await controller.wsqueeth();
      const nftAddr = await controller.vaultNFT();
      expect(squeethAddr).to.be.eq(
        squeeth.address,
        "squeeth address mismatch"
      );
      expect(nftAddr).to.be.eq(shortNFT.address, "nft address mismatch");
    });
  });

  describe("Liquidation", async () => {
    let vaultId: BigNumber;

    before("open vault", async () => {
      vaultId = await shortNFT.nextId()

      const depositAmount = ethers.utils.parseUnits('45')
      const mintAmount = ethers.utils.parseUnits('0.01')
        
      const vaultBefore = await controller.vaults(vaultId)
      const squeethBalanceBefore = await squeeth.balanceOf(seller1.address)
      
      await controller.connect(seller1).mint(0, mintAmount, {value: depositAmount})

      const squeethBalanceAfter = await squeeth.balanceOf(seller1.address)
      const vaultAfter = await controller.vaults(vaultId)
      const normFactor = await controller.normalizationFactor()

      expect(vaultBefore.shortAmount.add(mintAmount.mul(ethers.utils.parseUnits('1')).div(normFactor)).eq(vaultAfter.shortAmount)).to.be.true
      expect(squeethBalanceBefore.add(mintAmount.mul(ethers.utils.parseUnits('1')).div(normFactor)).eq(squeethBalanceAfter)).to.be.true
    });

    it("Should revert liquidating a safe vault", async () => {
      const vaultBefore = await controller.vaults(vaultId)

      // liquidator mint wSqueeth
      await squeeth.connect(liquidator).mint(liquidator.address, vaultBefore.shortAmount)

      await expect(controller.connect(liquidator).liquidate(vaultId, vaultBefore.shortAmount)).to.be.revertedWith(
        'Can not liquidate safe vault'
      )
    })

    it("Should revert liquidating vault when repaying more than half of debt", async () => {
      // change oracle price to make vault liquidatable
      const newEthUsdPrice = ethers.utils.parseUnits('4000')
      await oracle.connect(random).setPrice(ethUSDPool.address, "1" , newEthUsdPrice)

      const vaultBefore = await controller.vaults(vaultId)

      await expect(controller.connect(liquidator).liquidate(vaultId, vaultBefore.shortAmount)).to.be.revertedWith(
        'Can not repay more than 50% of vault debt'
      )
    })

    it("Liquidate unsafe vault", async () => {
      const vaultBefore = await controller.vaults(vaultId)
      const liquidatorBalanceBefore = await provider.getBalance(liquidator.address)
      const squeethLiquidatorBalanceBefore = await squeeth.balanceOf(liquidator.address)

      const debtToRepay = vaultBefore.shortAmount.div(2)
      const tx = await controller.connect(liquidator).liquidate(vaultId, debtToRepay);
      const receipt = await tx.wait();
      
      const normFactor = await controller.normalizationFactor()
      let collateralToSell : BigNumber = BigNumber.from(4000).mul(BigNumber.from(10).pow(18)).mul(normFactor).mul(debtToRepay).div(BigNumber.from(10).pow(36))
      collateralToSell = collateralToSell.add(collateralToSell.div(10))

      const vaultAfter = await controller.vaults(vaultId)
      const liquidatorBalanceAfter = await provider.getBalance(liquidator.address)
      const liquidateEventCollateralToSell : BigNumber = (receipt.events?.find(event => event.event === 'Liquidate'))?.args?.collateralToSell;
      const squeethLiquidatorBalanceAfter = await squeeth.balanceOf(liquidator.address)

      expect(isSimilar(liquidatorBalanceAfter.sub(liquidatorBalanceBefore).toString(), collateralToSell.toString())).to.be.true
      expect(liquidateEventCollateralToSell.eq(collateralToSell)).to.be.true
      expect(vaultBefore.shortAmount.sub(vaultAfter.shortAmount).eq(debtToRepay)).to.be.true
      expect(vaultBefore.collateralAmount.sub(vaultAfter.collateralAmount).eq(collateralToSell)).to.be.true
      expect(squeethLiquidatorBalanceBefore.sub(squeethLiquidatorBalanceAfter).eq(debtToRepay)).to.be.true
    })
  })
});