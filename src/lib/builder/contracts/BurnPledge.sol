// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Burn to signal: holders pledge tokens straight to the dead address with
/// a public message, building an on-chain conviction leaderboard. The
/// contract never holds user funds (tokens move msg.sender -> burn sink in
/// one transferFrom), has no owner, and has no admin path of any kind.
/// Deployed by the LAURA swarm builder agent to give a launched token a
/// deflationary utility surface.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract BurnPledge {
    address public constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;
    IERC20 public immutable token;

    mapping(address => uint256) public burnedBy;
    uint256 public totalBurned;
    uint256 public pledgeCount;

    event Pledged(address indexed pledger, uint256 amount, string message);

    error ZeroAmount();
    error MessageTooLong();
    error TransferFailed();

    constructor(address token_) {
        require(token_ != address(0), "zero token");
        token = IERC20(token_);
    }

    function pledge(uint256 amount, string calldata message) external {
        if (amount == 0) revert ZeroAmount();
        if (bytes(message).length > 280) revert MessageTooLong();
        if (!token.transferFrom(msg.sender, BURN_SINK, amount)) revert TransferFailed();
        burnedBy[msg.sender] += amount;
        totalBurned += amount;
        pledgeCount += 1;
        emit Pledged(msg.sender, amount, message);
    }
}
