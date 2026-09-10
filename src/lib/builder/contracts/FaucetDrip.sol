// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Ownerless faucet: holds a token bag and drips a fixed amount per wallet
/// per fixed interval. There is no owner, no admin path, and no rescue:
/// every parameter is immutable and tokens can only ever leave through
/// claim(). Deployed by the LAURA swarm builder agent to give a launched
/// token a standing utility surface. The faucet dies gracefully when the
/// bag runs out (claims revert Empty) and revives if anyone tops it up
/// with a plain transfer.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract FaucetDrip {
    IERC20 public immutable token;
    uint256 public immutable claimAmount;
    uint256 public immutable claimIntervalSecs;

    mapping(address => uint256) public lastClaimAt;
    uint256 public totalClaims;
    uint256 public totalDripped;

    event Claimed(address indexed claimer, uint256 amount);

    error TooSoon(uint256 nextClaimAt);
    error Empty();
    error TransferFailed();

    constructor(address token_, uint256 claimAmount_, uint256 claimIntervalSecs_) {
        require(token_ != address(0), "zero token");
        require(claimAmount_ > 0, "zero amount");
        require(claimIntervalSecs_ >= 1 hours, "interval too short");
        token = IERC20(token_);
        claimAmount = claimAmount_;
        claimIntervalSecs = claimIntervalSecs_;
    }

    /// Next timestamp at which `who` may claim (0 = claimable now).
    function nextClaimAt(address who) external view returns (uint256) {
        uint256 last = lastClaimAt[who];
        if (last == 0 || block.timestamp >= last + claimIntervalSecs) return 0;
        return last + claimIntervalSecs;
    }

    function claim() external {
        uint256 last = lastClaimAt[msg.sender];
        if (last != 0 && block.timestamp < last + claimIntervalSecs) {
            revert TooSoon(last + claimIntervalSecs);
        }
        if (token.balanceOf(address(this)) < claimAmount) revert Empty();
        lastClaimAt[msg.sender] = block.timestamp;
        totalClaims += 1;
        totalDripped += claimAmount;
        if (!token.transfer(msg.sender, claimAmount)) revert TransferFailed();
        emit Claimed(msg.sender, claimAmount);
    }
}
