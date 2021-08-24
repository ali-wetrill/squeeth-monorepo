import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";

import { ethers, getNamedAccounts, deployments } from "hardhat"
import { expect } from "chai";
import { Contract, providers } from "ethers";
import { Controller, VaultNFTManager, WSqueeth, ShortHelper, WETH9 } from "../../typechain";

import { deployUniswapV3, deploySqueethCoreContracts, createPoolAndAddLiquidity } from '../setup'

describe("ShortHelper", function () {
  let shortHelper: ShortHelper
  // peer contracts
  let squeeth: WSqueeth
  let vaultNFT: VaultNFTManager
  let controller: Controller
  let swapRouter: Contract
  let positionManager: Contract
  let weth: WETH9

  let poolAddress: string

  // accounts
  let seller1: SignerWithAddress
  let seller2: SignerWithAddress
  let provider: providers.JsonRpcProvider;

  let seller1VaultId = 0;
  let seller2VaultId = 0; 

  this.beforeAll("Prepare accounts", async() => {
    const accounts = await ethers.getSigners();
    const [,_seller1, _seller2] = accounts;
    seller1 = _seller1
    seller2 = _seller2
    provider = ethers.provider
  })

  this.beforeAll("Deploy uniswap protocol & setup uniswap pool", async() => {
    const { deployer } = await getNamedAccounts();
    
    const uniDeployments = await deployUniswapV3()
    const coreDeployments = await deploySqueethCoreContracts()

    swapRouter = uniDeployments.swapRouter
    weth = uniDeployments.weth
    positionManager = uniDeployments.positionManager
    squeeth = coreDeployments.squeeth
    vaultNFT = coreDeployments.vaultNft
    controller = coreDeployments.controller

    // init uniswap pool: price = 0.3, seed with 5 squeeth (20 eth as collateral)
    poolAddress = await createPoolAndAddLiquidity(0.3, '5', '20', deployer, squeeth, weth, positionManager, controller, uniDeployments.uniswapFactory)
  })

  describe('Basic settings', async() => {
    it('should deploy ShortHelper', async () => {
      const { deployer } = await getNamedAccounts();
      const { deploy } = deployments;
      await deploy("ShortHelper", {
        from: deployer,
        args: [controller.address, swapRouter.address, weth.address]
      });
  
      // deploy short helper
      shortHelper = await ethers.getContract("ShortHelper", deployer);
  
      expect(await shortHelper.squeeth()).to.be.eq(squeeth.address, "squeeth address mismatch")
      expect(await shortHelper.vaultNFT()).to.be.eq(vaultNFT.address, "vaultNFT address mismatch")
      expect(await shortHelper.controller()).to.be.eq(controller.address, "controller address mismatch")
      expect(await shortHelper.router()).to.be.eq(swapRouter.address, "swapRouter address mismatch")
      expect(await shortHelper.weth()).to.be.eq(weth.address, "weth address mismatch")
    })
  })

  describe('Create short position', async() => {
    it ('should open new vault and sell squeeth, receive weth in return', async () => {
      const squeethAmount = ethers.utils.parseEther('0.1')
      const collateralAmount = ethers.utils.parseEther('2')
  
      const exactInputParam = {
        tokenIn: squeeth.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: seller1.address,
        deadline: Math.floor(Date.now() / 1000 + 86400),
        amountIn: squeethAmount,
        amountOutMinimum: 0, // no slippage control now
        sqrtPriceLimitX96: 0,
      }
  
      const nftBalanceBefore = await vaultNFT.balanceOf(seller1.address)
      const poolSqueethBefore = await squeeth.balanceOf(poolAddress)
      const sellerWethBefore = await weth.balanceOf(seller1.address)
      const poolWethBefore = await weth.balanceOf(poolAddress)

      seller1VaultId = (await vaultNFT.nextId()).toNumber()
  
      // mint and trade
      await shortHelper.connect(seller1).openShort(0, squeethAmount, exactInputParam, {value: collateralAmount} )
  
      const nftBalanceAfter = await vaultNFT.balanceOf(seller1.address)
      const poolSqueethAfter = await squeeth.balanceOf(poolAddress)
      const sellerWethAfter = await weth.balanceOf(seller1.address)
      const poolWethAfter = await weth.balanceOf(poolAddress)
  
      expect(nftBalanceAfter.eq(nftBalanceBefore.add(1))).to.be.true
      expect(poolSqueethAfter.toString()).to.be.eq(poolSqueethBefore.add(squeethAmount), "squeeth mismatch")
      expect(poolWethBefore.sub(poolWethAfter).toString()).to.be.eq(sellerWethAfter.sub(sellerWethBefore), "weth mismatch")
    })

    it ('should open new vault and sell squeeth, receive eth at the end', async () => {
      const squeethAmount = ethers.utils.parseEther('0.1')
      const collateralAmount = ethers.utils.parseEther('2')
  
      const exactInputParam = {
        tokenIn: squeeth.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: shortHelper.address, // specify shortHelper as recipient to unwrap weth.
        deadline: Math.floor(Date.now() / 1000 + 86400),
        amountIn: squeethAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }
  
      const nftBalanceBefore = await vaultNFT.balanceOf(seller2.address)
      const poolSqueethBefore = await squeeth.balanceOf(poolAddress)
      const sellerEthBefore = await provider.getBalance(seller2.address)
      const poolWethBefore = await weth.balanceOf(poolAddress)
  
      seller2VaultId = (await vaultNFT.nextId()).toNumber()

      // mint and trade
      await shortHelper.connect(seller2).openShort(0, squeethAmount, exactInputParam, {
          value: collateralAmount, 
          gasPrice: 0 // won't cost gas so we can calculate eth recieved
        }
      )
  
      const nftBalanceAfter = await vaultNFT.balanceOf(seller2.address)
      const poolSqueethAfter = await squeeth.balanceOf(poolAddress)
      const sellerEthAfter = await provider.getBalance(seller2.address)
      const poolWethAfter = await weth.balanceOf(poolAddress)
  
      expect(nftBalanceAfter.eq(nftBalanceBefore.add(1))).to.be.true
      expect(poolSqueethAfter.toString()).to.be.eq(poolSqueethBefore.add(squeethAmount), "squeeth mismatch")
      expect(poolWethBefore.sub(poolWethAfter).toString()).to.be.eq(
        sellerEthAfter.add(collateralAmount).sub(sellerEthBefore), "weth mismatch"
      )
    })

  })

  describe('Close short position', async() => {

    it ('should partially close a short position and get back eth', async () => {
      const buyBackSqueethAmount = ethers.utils.parseEther('0.1')
      const withdrawCollateralAmount = ethers.utils.parseEther('1')

      // max amount to buy back 0.1 squeeth
      const amountInMaximum = ethers.utils.parseEther('0.5')
  
      const exactOutputParam = {
        tokenIn: weth.address,
        tokenOut: squeeth.address,
        fee: 3000,
        recipient: shortHelper.address,
        deadline: Math.floor(Date.now() / 1000 + 86400),
        amountOut: buyBackSqueethAmount,
        amountInMaximum,
        sqrtPriceLimitX96: 0,
      }
  
      const nftBalanceBefore = await vaultNFT.balanceOf(seller1.address)
      const poolSqueethBefore = await squeeth.balanceOf(poolAddress)
      const sellerEthBefore = await provider.getBalance(seller1.address)
      const poolWethBefore = await weth.balanceOf(poolAddress)
  
      await vaultNFT.connect(seller1).approve(shortHelper.address, seller1VaultId, {gasPrice: 0})

      // buy and close
      await shortHelper.connect(seller1).closeShort(seller1VaultId, buyBackSqueethAmount, withdrawCollateralAmount, exactOutputParam, {
          value: amountInMaximum, // max amount used to buy back eth
          gasPrice: 0 // won't cost gas so we can calculate eth received
        }
      )
  
      const nftBalanceAfter = await vaultNFT.balanceOf(seller1.address)
      const poolSqueethAfter = await squeeth.balanceOf(poolAddress)
      const sellerEthAfter = await provider.getBalance(seller1.address)
      const poolWethAfter = await weth.balanceOf(poolAddress)
  
      expect(nftBalanceAfter.eq(nftBalanceBefore)).to.be.true
      expect(poolSqueethAfter.toString()).to.be.eq(poolSqueethBefore.sub(buyBackSqueethAmount), "squeeth mismatch")
      expect(poolWethAfter.sub(poolWethBefore).toString()).to.be.eq(
        sellerEthBefore.add(withdrawCollateralAmount).sub(sellerEthAfter), "weth mismatch"
      )
    })

    it ('should fully close a short position and get back eth', async () => {
      const vaultToClose = await controller.vaults(seller2VaultId)
      const buyBackSqueethAmount = vaultToClose.shortAmount
      const withdrawCollateralAmount = vaultToClose.collateralAmount

      // max amount to buy back 0.1 squeeth
      const amountInMaximum = ethers.utils.parseEther('0.5')
  
      const exactOutputParam = {
        tokenIn: weth.address,
        tokenOut: squeeth.address,
        fee: 3000,
        recipient: shortHelper.address,
        deadline: Math.floor(Date.now() / 1000 + 86400),
        amountOut: buyBackSqueethAmount,
        amountInMaximum,
        sqrtPriceLimitX96: 0,
      }
  
      const nftBalanceBefore = await vaultNFT.balanceOf(seller2.address)
      const poolSqueethBefore = await squeeth.balanceOf(poolAddress)
      const sellerEthBefore = await provider.getBalance(seller2.address)
      const poolWethBefore = await weth.balanceOf(poolAddress)
  
      await vaultNFT.connect(seller2).approve(shortHelper.address, seller2VaultId, {gasPrice: 0})

      // buy and close
      await shortHelper.connect(seller2).closeShort(seller2VaultId, buyBackSqueethAmount, withdrawCollateralAmount, exactOutputParam, {
          value: amountInMaximum, // max amount used to buy back eth
          gasPrice: 0 // won't cost gas so we can calculate eth received
        }
      )
  
      const nftBalanceAfter = await vaultNFT.balanceOf(seller2.address)
      const poolSqueethAfter = await squeeth.balanceOf(poolAddress)
      const sellerEthAfter = await provider.getBalance(seller2.address)
      const poolWethAfter = await weth.balanceOf(poolAddress)
  
      expect(nftBalanceAfter.eq(nftBalanceBefore.sub(1))).to.be.true
      expect(poolSqueethAfter.toString()).to.be.eq(poolSqueethBefore.sub(buyBackSqueethAmount), "squeeth mismatch")
      expect(poolWethAfter.sub(poolWethBefore).toString()).to.be.eq(
        sellerEthBefore.add(withdrawCollateralAmount).sub(sellerEthAfter), "weth mismatch"
      )
    })

  })
});