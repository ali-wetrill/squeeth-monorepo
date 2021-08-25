//SPDX-License-Identifier: MIT

pragma solidity >=0.8.0 <0.9.0;

import {IWSqueeth} from "../interfaces/IWSqueeth.sol";
import {IVaultManagerNFT} from "../interfaces/IVaultManagerNFT.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {VaultLib} from "../libs/VaultLib.sol";

/// Errors
error InvalidOracleAddress(address oracle);
error InvalidEthUsdPoolAddress(address ethUSDPool);
error InvalidwSqueethEthPoolAddress(address wSqueethEthPool);
error InvalidSqueethAddress(address squeethAddress);
error InvalidVaultManagerNftAddress(address vaultManagerNFTAddress);

contract Controller is Initializable {
    using VaultLib for VaultLib.Vault;
    using Address for address payable;

    uint256 internal constant secInDay = 86400;

    address public ethUSDPool;
    address public wSqueethEthPool;

    uint256 public normalizationFactor;
    uint256 public lastFundingUpdateTimestamp;

    /// @dev The token ID vault data
    mapping(uint256 => VaultLib.Vault) public vaults;

    IVaultManagerNFT public vaultNFT;
    IWSqueeth public squeeth;
    IOracle public oracle;

    /// Events
    event OpenVault(uint256 vaultId);
    event CloseVault(uint256 vaultId);
    event DepositCollateral(uint256 vaultId, uint128 amount, uint128 collateralId);
    event WithdrawCollateral(uint256 vaultId, uint256 amount, uint128 collateralId);
    event MintSqueeth(uint256 amount, uint256 vaultId);
    event BurnSqueeth(uint256 amount, uint256 vaultId);
    event UpdateOperator(uint256 vaultId, address operator);
    event Liquidate(uint256 vaultId, uint256 debtAmount, uint256 collateralToSell);

    /**
     * put down collateral and mint squeeth.
     * This mints an amount of rSqueeth.
     */
    function mint(uint256 _vaultId, uint128 _mintAmount) external payable returns (uint256) {
        _applyFunding();
        if (_vaultId == 0) _vaultId = _openVault(msg.sender);
        if (msg.value > 0) _depositETHCollateral(_vaultId, msg.value);
        if (_mintAmount > 0) _mintSqueeth(msg.sender, _vaultId, _mintAmount);
        _checkVault(_vaultId);
        return _vaultId;
    }

    /**
     * Deposit collateral into a vault
     */
    function deposit(uint256 _vaultId) external payable {
        _applyFunding();
        _depositETHCollateral(_vaultId, msg.value);
    }

    /**
     * Withdraw collateral from a vault.
     */
    function withdraw(uint256 _vaultId, uint256 _amount) external payable {
        _applyFunding();
        _withdrawCollateral(msg.sender, _vaultId, _amount);
        _checkVault(_vaultId);
    }

    /**
     * burn squueth and remove collateral from a vault.
     * This burns an amount of wSqueeth.
     */
    function burn(
        uint256 _vaultId,
        uint256 _amount,
        uint256 _withdrawAmount
    ) external returns (uint256) {
        _applyFunding();
        if (_amount > 0) _burnSqueeth(msg.sender, _vaultId, _amount);
        if (_withdrawAmount > 0) _withdrawCollateral(msg.sender, _vaultId, _withdrawAmount);
        if (vaults[_vaultId].isEmpty()) {
            _closeVault(_vaultId);
            _vaultId = 0;
        }
        _checkVault(_vaultId);

        return _vaultId;
    }

    function liquidate(uint256 _vaultId, uint256 _debtAmount) external {
        _applyFunding();

        require(!isVaultSafe(vaults[_vaultId]), "Can not liquidate");

        uint256 indexPrice = _getIndex(600); // get index price using TWAP furing last 10min
        uint256 collateralToSell = (indexPrice * _debtAmount) / 1e18;
        // tood: add 10% of collateral

        squeeth.burn(msg.sender, _debtAmount);
        payable(msg.sender).sendValue(collateralToSell);

        emit Liquidate(_vaultId, _debtAmount, collateralToSell);
    }

    function getIndex(uint32 _period) external view returns (uint256) {
        return _getIndex(_period);
    }

    function getDenormalizedMark(uint32 _period) external view returns (uint256) {
        return _getDenormalizedMark(_period);
    }

    /**
     * Authorize an address to modify the vault. Can be revoke by setting address to 0.
     */
    function updateOperator(uint256 _vaultId, address _operator) external {
        require(_canModifyVault(_vaultId, msg.sender), "not allowed");
        vaults[_vaultId].operator = _operator;
        emit UpdateOperator(_vaultId, _operator);
    }

    /**
     * init controller with squeeth and short NFT address
     */
    function init(
        address _oracle,
        address _vaultNFT,
        address _squeeth,
        address _ethUsdPool,
        address _wSqueethEthPool
    ) public initializer {
        if (_oracle == address(0)) revert InvalidOracleAddress({oracle: _oracle});
        if (_vaultNFT == address(0)) revert InvalidVaultManagerNftAddress({vaultManagerNFTAddress: _vaultNFT});
        if (_squeeth == address(0)) revert InvalidSqueethAddress({squeethAddress: _squeeth});
        if (_ethUsdPool == address(0)) revert InvalidEthUsdPoolAddress({ethUSDPool: _ethUsdPool});
        if (_wSqueethEthPool == address(0)) revert InvalidwSqueethEthPoolAddress({wSqueethEthPool: _wSqueethEthPool});

        oracle = IOracle(_oracle);
        vaultNFT = IVaultManagerNFT(_vaultNFT);
        squeeth = IWSqueeth(_squeeth);

        ethUSDPool = _ethUsdPool;
        wSqueethEthPool = _wSqueethEthPool;

        normalizationFactor = 1e18;
        lastFundingUpdateTimestamp = block.timestamp;
    }

    /**
     * Internal functions
     */

    function _canModifyVault(uint256 _vaultId, address _account) internal view returns (bool) {
        return vaultNFT.ownerOf(_vaultId) == _account || vaults[_vaultId].operator == _account;
    }

    /**
     * create a new vault and bind it with a new NFT id.
     */
    function _openVault(address _recipient) internal returns (uint256 vaultId) {
        vaultId = vaultNFT.mintNFT(_recipient);
        vaults[vaultId] = VaultLib.Vault({
            NFTCollateralId: 0,
            collateralAmount: 0,
            shortAmount: 0,
            operator: address(0)
        });
        emit OpenVault(vaultId);
    }

    /**
     * remove vault data and burn corresponding NFT
     */
    function _closeVault(uint256 _vaultId) internal {
        require(_canModifyVault(_vaultId, msg.sender), "not allowed");
        vaultNFT.burnNFT(_vaultId);
        delete vaults[_vaultId];
        emit CloseVault(_vaultId);
    }

    /**
     * add collateral to a vault
     */
    function _depositETHCollateral(uint256 _vaultId, uint256 _amount) internal {
        vaults[_vaultId].depositETHCollateral(uint128(_amount));
        emit DepositCollateral(_vaultId, uint128(_amount), 0);
    }

    /**
     * remove collateral from the vault
     */
    function _withdrawCollateral(
        address _account,
        uint256 _vaultId,
        uint256 _amount
    ) internal {
        require(_canModifyVault(_vaultId, _account), "not allowed");
        vaults[_vaultId].withdrawETHCollateral(_amount);
        payable(_account).sendValue(_amount);
        emit WithdrawCollateral(_vaultId, _amount, 0);
    }

    /**
     * mint squeeth (ERC20) to an account
     */
    function _mintSqueeth(
        address _account,
        uint256 _vaultId,
        uint256 _amount
    ) internal {
        require(_canModifyVault(_vaultId, _account), "not allowed");

        uint256 amountToMint = (_amount * 1e18) / normalizationFactor;

        vaults[_vaultId].mintSqueeth(amountToMint);

        emit MintSqueeth(amountToMint, _vaultId);

        squeeth.mint(_account, amountToMint);
    }

    /**
     * burn squeeth (ERC20) from an account.
     */
    function _burnSqueeth(
        address _account,
        uint256 _vaultId,
        uint256 _amount
    ) internal {
        vaults[_vaultId].burnSqueeth(_amount);
        emit BurnSqueeth(_amount, _vaultId);

        squeeth.burn(_account, _amount);
    }

    /**
     * External function to update the normalized factor as a way to pay funding.
     */
    function applyFunding() external {
        _applyFunding();
    }

    /**
     * Update the normalized factor as a way to pay funding.
     */
    function _applyFunding() internal {
        uint32 period = uint32(block.timestamp - lastFundingUpdateTimestamp);

        if (period == 0) return;

        uint256 mark = _getDenormalizedMark(period);
        uint256 index = _getIndex(period);
        uint256 rFunding = period / secInDay;
        uint256 newNormalizationFactor = (mark * 1e18) / ((1 + rFunding) * mark - index * rFunding);

        normalizationFactor = (normalizationFactor * newNormalizationFactor) / 1e18;
        lastFundingUpdateTimestamp = block.timestamp;
    }

    /**
     * @dev check that the vault is solvent and has enough collateral.
     */
    function _checkVault(uint256 _vaultId) internal view {
        if (_vaultId == 0) return;

        VaultLib.Vault memory vault = vaults[_vaultId];

        require(isVaultSafe(vault), "Invalid state");
    }

    function isVaultSafe(VaultLib.Vault memory _vault) internal view returns (bool) {
        uint256 ethUsdPrice = _getTwap(ethUSDPool, 600);

        return VaultLib.isProperlyCollateralized(_vault, normalizationFactor, ethUsdPrice);
    }

    function _getIndex(uint32 _period) internal view returns (uint256) {
        uint256 ethUSDPrice = _getTwap(ethUSDPool, _period);
        return (ethUSDPrice * ethUSDPrice) / 1e18;
    }

    function _getDenormalizedMark(uint32 _period) public view returns (uint256) {
        uint256 ethUSDPrice = _getTwap(ethUSDPool, _period);
        uint256 squeethEthPrice = _getTwap(wSqueethEthPool, _period);

        return (squeethEthPrice * ethUSDPrice) / normalizationFactor;
    }

    function _getTwap(address _pool, uint32 _period) internal view returns (uint256) {
        uint256 twap = oracle.getTwaPrice(_pool, _period);
        require(twap != 0, "WAP WAP WAP");

        return twap;
    }
}
