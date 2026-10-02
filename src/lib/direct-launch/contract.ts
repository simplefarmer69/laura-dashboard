/**
 * LAURA's own tax token, launched straight on chain (no launchpad).
 *
 * One fixed, code owned Solidity source; every launch is the same contract
 * with different constructor arguments, so a compile that passes here
 * verifies byte for byte on the explorer with constructor args auto
 * detected, and Mint can never ship a contract the operator has not read.
 *
 * WHAT IT DOES
 *   Buy tax on a marked concentrated liquidity pool (the token's own vDEX
 *   pool), decaying by the minute from startTaxBps to floorTaxBps after the
 *   pool is marked, split three ways: holder rewards, burn, treasury.
 *   Holder rewards are a pull based dividend accumulator paid in the token
 *   itself: claim() for yourself, claimFor(list) for anyone (that is the
 *   airdrop: LAURA or any holder can push everyone's rewards out). Reward
 *   mode 1 ("diamond") forfeits a wallet's unclaimed rewards to everyone
 *   else the moment it sends or sells, so rewards accrue to the hands that
 *   stay. The deployer marks the pool once and then finalizes, which burns
 *   the only admin key.
 *
 * WHY BUY TAX ONLY
 *   Concentrated liquidity pools (Uniswap V3 and the Slipstream style vDEX)
 *   check the exact amount a swap delivers into the pool, so a token that
 *   taxes transfers INTO the pool makes every sell revert. Taxing transfers
 *   OUT of the pool (buys) is the only transfer tax a CL pool tolerates.
 *   Sells are free by construction; the contract documents it.
 */

export const TAX_TOKEN_CONTRACT_NAME = "LauraTaxToken";

export const TAX_TOKEN_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LauraTaxToken
/// @notice An ERC20 with a decaying buy tax on its own liquidity pool. The tax is split
///         between holder rewards (claimable, pro rata, paid in this token), a burn and the
///         treasury. Sells are never taxed: concentrated liquidity pools reject tokens that
///         take a cut on the way in. The deployer marks the pool once, then finalizes, after
///         which no address can change anything.
/// @dev Reward mode 0 keeps a holder's unclaimed rewards across transfers. Reward mode 1
///      ("diamond hands") forfeits a holder's unclaimed rewards to every other holder when
///      that holder sends or sells, so rewards flow to the wallets that stay.
contract LauraTaxToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event PoolMarked(address indexed pool, address indexed positionManager, uint256 taxStartedAt);
    event Finalized();
    event TaxTaken(address indexed buyer, uint256 toHolders, uint256 burned, uint256 toTreasury);
    event RewardsClaimed(address indexed account, uint256 amount);
    event RewardsForfeited(address indexed account, uint256 amount);

    /// @notice Deployer until finalize(); address(0) afterwards.
    address public owner;
    /// @notice Receives the treasury share of every tax.
    address public immutable treasury;
    /// @notice The liquidity pool whose outgoing transfers (buys) are taxed. Zero until marked.
    address public pool;
    /// @notice The pool's position manager; exempt so liquidity providers collecting fees are not taxed.
    address public positionManager;
    /// @notice When the pool was marked; the tax decays from this moment.
    uint256 public taxStartedAt;

    uint16 public immutable startTaxBps;
    uint16 public immutable floorTaxBps;
    uint16 public immutable decayBpsPerMinute;
    uint16 public immutable holderShareBps;
    uint16 public immutable burnShareBps;
    /// @notice 0 = dividend (rewards kept across transfers), 1 = diamond (unclaimed rewards forfeited on send or sell).
    uint8 public immutable rewardMode;

    uint256 private constant BPS = 10_000;
    uint256 private constant MAGNITUDE = 2 ** 128;

    uint256 public magnifiedRewardPerShare;
    mapping(address => int256) private rewardCorrections;
    mapping(address => uint256) public rewardsWithdrawn;
    mapping(address => bool) public excludedFromRewards;
    mapping(address => bool) public taxExempt;
    /// @notice Supply held by reward eligible wallets (everything except the pool, the manager, this contract and the treasury).
    uint256 public eligibleSupply;
    uint256 public totalRewardsDistributed;
    uint256 public totalBurned;
    uint256 public totalTreasuryTax;

    error NotOwner();
    error AlreadyMarked();
    error ZeroAddress();
    error BadShares();
    error BadTax();
    error InsufficientBalance();
    error InsufficientAllowance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address treasury_,
        uint16 startTaxBps_,
        uint16 floorTaxBps_,
        uint16 decayBpsPerMinute_,
        uint16 holderShareBps_,
        uint16 burnShareBps_,
        uint8 rewardMode_
    ) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (startTaxBps_ > 9_900 || floorTaxBps_ > startTaxBps_) revert BadTax();
        if (uint256(holderShareBps_) + uint256(burnShareBps_) > BPS) revert BadShares();
        if (rewardMode_ > 1) revert BadShares();
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
        treasury = treasury_;
        startTaxBps = startTaxBps_;
        floorTaxBps = floorTaxBps_;
        decayBpsPerMinute = decayBpsPerMinute_;
        holderShareBps = holderShareBps_;
        burnShareBps = burnShareBps_;
        rewardMode = rewardMode_;

        excludedFromRewards[address(this)] = true;
        excludedFromRewards[treasury_] = true;
        excludedFromRewards[address(0)] = true;
        taxExempt[msg.sender] = true;
        taxExempt[treasury_] = true;
        taxExempt[address(this)] = true;

        totalSupply = supply_;
        balanceOf[msg.sender] = supply_;
        // The deployer is usually the treasury as well, and the treasury never earns rewards.
        eligibleSupply = excludedFromRewards[msg.sender] ? 0 : supply_;
        emit Transfer(address(0), msg.sender, supply_);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Marks the liquidity pool whose buys are taxed. Once, by the deployer, before finalize().
    function markPool(address pool_, address positionManager_) external onlyOwner {
        if (pool != address(0)) revert AlreadyMarked();
        if (pool_ == address(0) || positionManager_ == address(0)) revert ZeroAddress();
        pool = pool_;
        positionManager = positionManager_;
        taxStartedAt = block.timestamp;
        _setExcluded(pool_);
        _setExcluded(positionManager_);
        taxExempt[positionManager_] = true;
        emit PoolMarked(pool_, positionManager_, block.timestamp);
    }

    /// @notice Burns the admin key. After this nothing about the token can change.
    function finalize() external onlyOwner {
        owner = address(0);
        emit Finalized();
    }

    // ------------------------------------------------------------------ views

    /// @notice The buy tax in effect right now, in basis points.
    function currentTaxBps() public view returns (uint256) {
        if (pool == address(0)) return 0;
        uint256 minutesElapsed = (block.timestamp - taxStartedAt) / 60;
        uint256 decayed = minutesElapsed * uint256(decayBpsPerMinute);
        if (decayed >= uint256(startTaxBps) - uint256(floorTaxBps)) return floorTaxBps;
        return uint256(startTaxBps) - decayed;
    }

    /// @notice Seconds until the buy tax reaches its floor (0 once it has).
    function secondsUntilFloor() external view returns (uint256) {
        if (pool == address(0) || decayBpsPerMinute == 0) return 0;
        uint256 span = (uint256(startTaxBps) - uint256(floorTaxBps) + uint256(decayBpsPerMinute) - 1) / uint256(decayBpsPerMinute) * 60;
        uint256 elapsed = block.timestamp - taxStartedAt;
        return elapsed >= span ? 0 : span - elapsed;
    }

    /// @notice Rewards an account has earned in total (claimed and unclaimed).
    function accumulativeRewardOf(address account) public view returns (uint256) {
        if (excludedFromRewards[account]) return 0;
        int256 magnified = int256(magnifiedRewardPerShare * balanceOf[account]) + rewardCorrections[account];
        if (magnified <= 0) return 0;
        return uint256(magnified) / MAGNITUDE;
    }

    /// @notice Rewards an account can claim right now.
    function withdrawableRewardOf(address account) public view returns (uint256) {
        uint256 accumulated = accumulativeRewardOf(account);
        uint256 withdrawn = rewardsWithdrawn[account];
        return accumulated > withdrawn ? accumulated - withdrawn : 0;
    }

    // ---------------------------------------------------------------- rewards

    /// @notice Claim your own rewards.
    function claim() external returns (uint256) {
        return _claim(msg.sender);
    }

    /// @notice Push rewards to a list of holders. Anyone may call it; the caller pays the gas. This is the airdrop.
    function claimFor(address[] calldata accounts) external returns (uint256 total) {
        for (uint256 i = 0; i < accounts.length; i++) {
            total += _claim(accounts[i]);
        }
    }

    function _claim(address account) internal returns (uint256 amount) {
        amount = withdrawableRewardOf(account);
        if (amount == 0) return 0;
        rewardsWithdrawn[account] += amount;
        _move(address(this), account, amount);
        emit RewardsClaimed(account, amount);
    }

    function _distribute(uint256 amount) internal returns (bool distributed) {
        if (amount == 0) return true;
        if (eligibleSupply == 0) return false;
        magnifiedRewardPerShare += (amount * MAGNITUDE) / eligibleSupply;
        totalRewardsDistributed += amount;
        return true;
    }

    function _setExcluded(address account) internal {
        if (excludedFromRewards[account]) return;
        uint256 pending = withdrawableRewardOf(account);
        excludedFromRewards[account] = true;
        eligibleSupply -= balanceOf[account];
        if (pending > 0) {
            rewardsWithdrawn[account] += pending;
            if (!_distribute(pending)) _move(address(this), treasury, pending);
            emit RewardsForfeited(account, pending);
        }
    }

    // ------------------------------------------------------------------ ERC20

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();

        bool isBuy = pool != address(0) && from == pool && !taxExempt[to];
        if (isBuy) {
            uint256 tax = (amount * currentTaxBps()) / BPS;
            if (tax > 0) {
                uint256 toHolders = (tax * uint256(holderShareBps)) / BPS;
                uint256 toBurn = (tax * uint256(burnShareBps)) / BPS;
                uint256 toTreasury = tax - toHolders - toBurn;
                if (toHolders > 0) {
                    if (eligibleSupply == 0) {
                        // Nobody to reward yet (the very first buy): the holder share goes to the treasury.
                        toTreasury += toHolders;
                        toHolders = 0;
                    } else {
                        _move(from, address(this), toHolders);
                        _distribute(toHolders);
                    }
                }
                if (toBurn > 0) _burn(from, toBurn);
                if (toTreasury > 0) _move(from, treasury, toTreasury);
                totalTreasuryTax += toTreasury;
                emit TaxTaken(to, toHolders, toBurn, toTreasury);
                amount -= tax;
            }
        }

        _move(from, to, amount);

        if (rewardMode == 1 && !excludedFromRewards[from] && from != to) {
            uint256 pending = withdrawableRewardOf(from);
            if (pending > 0) {
                rewardsWithdrawn[from] += pending;
                if (!_distribute(pending)) _move(address(this), treasury, pending);
                emit RewardsForfeited(from, pending);
            }
        }
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        int256 magnified = int256(magnifiedRewardPerShare * amount);
        rewardCorrections[from] += magnified;
        rewardCorrections[to] -= magnified;
        bool fromEligible = !excludedFromRewards[from];
        bool toEligible = !excludedFromRewards[to];
        if (fromEligible && !toEligible) eligibleSupply -= amount;
        else if (!fromEligible && toEligible) eligibleSupply += amount;
        emit Transfer(from, to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
        rewardCorrections[from] += int256(magnifiedRewardPerShare * amount);
        if (!excludedFromRewards[from]) eligibleSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}
`;

/** Constructor arguments in ABI order; the executor encodes exactly these. */
export interface TaxTokenConstructorArgs {
  name: string;
  symbol: string;
  supplyWei: bigint;
  treasury: `0x${string}`;
  startTaxBps: number;
  floorTaxBps: number;
  decayBpsPerMinute: number;
  holderShareBps: number;
  burnShareBps: number;
  rewardMode: 0 | 1;
}

export function taxTokenConstructorValues(a: TaxTokenConstructorArgs): readonly [string, string, bigint, `0x${string}`, number, number, number, number, number, number] {
  return [a.name, a.symbol, a.supplyWei, a.treasury, a.startTaxBps, a.floorTaxBps, a.decayBpsPerMinute, a.holderShareBps, a.burnShareBps, a.rewardMode] as const;
}

/** The surface the executor and the console read after deploy. */
export const TAX_TOKEN_ABI = [
  { type: "function", name: "markPool", stateMutability: "nonpayable", inputs: [{ name: "pool_", type: "address" }, { name: "positionManager_", type: "address" }], outputs: [] },
  { type: "function", name: "finalize", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "pool", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "currentTaxBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "eligibleSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalRewardsDistributed", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalBurned", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalTreasuryTax", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "withdrawableRewardOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "claimFor", stateMutability: "nonpayable", inputs: [{ name: "accounts", type: "address[]" }], outputs: [{ name: "total", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;
