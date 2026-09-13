// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title OwnershipMarket
/// @author LAURA (the StonkBrokers agent swarm), Robinhood Chain 4663
/// @notice A marketplace for ownership of smart contracts. Any contract that
///         exposes `owner()` and `transferOwnership(address)` (OpenZeppelin
///         Ownable, Ownable2Step, most NFT collections, tokens, vaults) can be
///         listed for sale in the native coin or any ERC-20.
///
///         Flow:
///           1. Seller, while still the owner, calls `createListing` with the
///              target contract, the payment token (address(0) = native), the
///              price and a short description.
///           2. Seller calls `transferOwnership(<this market>)` on the target.
///              The market is now the escrow owner. (Ownable2Step targets:
///              anyone then calls `acceptEscrow`.)
///           3. A buyer calls `buy` and pays the price into the market.
///           4. Anyone calls `deliver`; the market transfers ownership of the
///              target to the buyer. The seller then calls `claimProceeds`
///              for the price minus the 1% protocol fee.
///
///         If nobody delivers within REFUND_DELAY the buyer can take their
///         payment back with `refund`, and the seller can `cancel` to have the
///         escrowed ownership returned. The market has no owner, no admin, no
///         pause and no upgrade path; the fee recipient is fixed at deploy.
///
/// @dev    ORDER MATTERS: list first, then transfer ownership. Ownership sent
///         to this market without a live listing cannot be attributed to a
///         seller and cannot be returned. The market itself only ever calls
///         `owner()`, `transferOwnership()` and `acceptOwnership()` on targets.
interface IOwnable {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface IOwnable2Step {
    function acceptOwnership() external;
    function pendingOwner() external view returns (address);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract OwnershipMarket {
    enum Status {
        None,
        Listed,
        Sold,
        Delivered,
        Cancelled,
        Refunded
    }

    struct Listing {
        address target;
        address seller;
        address buyer;
        address payToken;
        uint256 price;
        uint256 paid;
        uint64 createdAt;
        uint64 soldAt;
        Status status;
        bool proceedsClaimed;
        string description;
    }

    /// @notice Protocol fee on every completed sale, in basis points (1%).
    uint256 public constant FEE_BPS = 100;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Maximum byte length of a listing description.
    uint256 public constant MAX_DESCRIPTION_BYTES = 280;
    /// @notice Time after a sale during which delivery must happen before the buyer may refund.
    uint256 public constant REFUND_DELAY = 1 days;

    /// @notice Receives protocol fees. Fixed at deploy; there is no admin to change it.
    address public immutable feeRecipient;

    uint256 public listingCount;
    mapping(uint256 => Listing) private _listings;
    /// @notice Live listing id per target (0 when none). One live listing per contract.
    mapping(address => uint256) public activeListingOf;
    /// @notice Protocol fees accrued per payment token (address(0) = native), claimable by anyone to feeRecipient.
    mapping(address => uint256) public accruedFees;

    uint256 private _entered = 1;

    event Listed(
        uint256 indexed id,
        address indexed target,
        address indexed seller,
        address payToken,
        uint256 price,
        string description
    );
    event ListingUpdated(uint256 indexed id, address payToken, uint256 price, string description);
    event Escrowed(uint256 indexed id, address indexed target);
    event Cancelled(uint256 indexed id, address indexed by, bool ownershipReturned);
    event Sold(uint256 indexed id, address indexed buyer, address payToken, uint256 paid);
    event Delivered(uint256 indexed id, address indexed target, address indexed newOwner, uint256 fee);
    event ProceedsClaimed(uint256 indexed id, address indexed seller, address payToken, uint256 amount);
    event Refunded(uint256 indexed id, address indexed buyer, address payToken, uint256 amount);
    event FeesWithdrawn(address indexed payToken, address indexed to, uint256 amount);

    error Reentrancy();
    error ZeroAddress();
    error ZeroPrice();
    error DescriptionTooLong();
    error NotAContract();
    error AlreadyListed();
    error NotTargetOwner();
    error NotSeller();
    error NotBuyer();
    error WrongStatus();
    error NotEscrowed();
    error ListingChanged();
    error WrongValue();
    error TransferFailed();
    error DeliveryFailed();
    error RefundTooEarly();
    error NothingToClaim();
    error NotStale();

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(address feeRecipient_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
    }

    // ---------------------------------------------------------------- views

    function getListing(uint256 id) external view returns (Listing memory) {
        return _listings[id];
    }

    /// @notice True when the market currently holds ownership of the listing's target.
    function isEscrowed(uint256 id) external view returns (bool) {
        Listing storage l = _listings[id];
        if (l.status == Status.None) return false;
        return _ownerOf(l.target) == address(this);
    }

    /// @notice Fee and net proceeds a sale at `paid` would produce.
    function quote(uint256 paid) public pure returns (uint256 fee, uint256 proceeds) {
        fee = (paid * FEE_BPS) / BPS_DENOMINATOR;
        proceeds = paid - fee;
    }

    // -------------------------------------------------------------- selling

    /// @notice Create a listing. Caller must be the CURRENT owner of `target`;
    ///         transfer ownership to this market afterwards to go live.
    function createListing(
        address target,
        address payToken,
        uint256 price,
        string calldata description
    ) external returns (uint256 id) {
        if (price == 0) revert ZeroPrice();
        if (bytes(description).length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();
        if (target.code.length == 0) revert NotAContract();
        if (payToken != address(0) && payToken.code.length == 0) revert NotAContract();
        if (activeListingOf[target] != 0) revert AlreadyListed();
        if (_ownerOf(target) != msg.sender) revert NotTargetOwner();

        id = ++listingCount;
        Listing storage l = _listings[id];
        l.target = target;
        l.seller = msg.sender;
        l.payToken = payToken;
        l.price = price;
        l.createdAt = uint64(block.timestamp);
        l.status = Status.Listed;
        l.description = description;
        activeListingOf[target] = id;

        emit Listed(id, target, msg.sender, payToken, price, description);
    }

    /// @notice Seller may change price, payment token and description while unsold.
    function updateListing(uint256 id, address payToken, uint256 price, string calldata description) external {
        Listing storage l = _listings[id];
        if (msg.sender != l.seller) revert NotSeller();
        if (l.status != Status.Listed) revert WrongStatus();
        if (price == 0) revert ZeroPrice();
        if (bytes(description).length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();
        if (payToken != address(0) && payToken.code.length == 0) revert NotAContract();
        l.payToken = payToken;
        l.price = price;
        l.description = description;
        emit ListingUpdated(id, payToken, price, description);
    }

    /// @notice For Ownable2Step targets: after the seller calls
    ///         `transferOwnership(market)`, anyone completes the escrow here.
    function acceptEscrow(uint256 id) external nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert WrongStatus();
        IOwnable2Step(l.target).acceptOwnership();
        if (_ownerOf(l.target) != address(this)) revert NotEscrowed();
        emit Escrowed(id, l.target);
    }

    /// @notice Seller withdraws an unsold (or refunded) listing. Escrowed
    ///         ownership is handed back to the seller.
    function cancel(uint256 id) external nonReentrant {
        Listing storage l = _listings[id];
        if (msg.sender != l.seller) revert NotSeller();
        if (l.status != Status.Listed && l.status != Status.Refunded) revert WrongStatus();
        _close(id, l, Status.Cancelled);
        bool returned = _returnOwnership(l);
        emit Cancelled(id, msg.sender, returned);
    }

    /// @notice Anyone may close a stale listing whose target is owned by
    ///         neither the seller nor the market (the seller moved it elsewhere).
    function expire(uint256 id) external nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert WrongStatus();
        address current = _ownerOf(l.target);
        if (current == l.seller || current == address(this)) revert NotStale();
        _close(id, l, Status.Cancelled);
        emit Cancelled(id, msg.sender, false);
    }

    // --------------------------------------------------------------- buying

    /// @notice Pay the listed price. `expectedPayToken` / `expectedPrice`
    ///         protect the buyer from a listing edited in the same block.
    ///         Native listings: send exactly `price` as msg.value.
    ///         ERC-20 listings: approve the market for `price` first.
    function buy(uint256 id, address expectedPayToken, uint256 expectedPrice) external payable nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert WrongStatus();
        if (l.payToken != expectedPayToken || l.price != expectedPrice) revert ListingChanged();
        if (_ownerOf(l.target) != address(this)) revert NotEscrowed();

        uint256 received;
        if (l.payToken == address(0)) {
            if (msg.value != l.price) revert WrongValue();
            received = msg.value;
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20 token = IERC20(l.payToken);
            uint256 before = token.balanceOf(address(this));
            _safeTransferFrom(l.payToken, msg.sender, address(this), l.price);
            received = token.balanceOf(address(this)) - before;
            if (received == 0) revert TransferFailed();
        }

        l.buyer = msg.sender;
        l.paid = received;
        l.soldAt = uint64(block.timestamp);
        l.status = Status.Sold;
        emit Sold(id, msg.sender, l.payToken, received);
    }

    /// @notice Anyone executes the ownership transfer to the buyer. Books the
    ///         protocol fee and unlocks the seller's proceeds.
    function deliver(uint256 id) external nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Sold) revert WrongStatus();

        (uint256 fee, ) = quote(l.paid);
        _close(id, l, Status.Delivered);
        accruedFees[l.payToken] += fee;

        IOwnable(l.target).transferOwnership(l.buyer);
        if (_ownerOf(l.target) != l.buyer && _pendingOwnerOf(l.target) != l.buyer) revert DeliveryFailed();

        emit Delivered(id, l.target, l.buyer, fee);
    }

    /// @notice Seller collects price minus fee once delivered.
    function claimProceeds(uint256 id) external nonReentrant {
        Listing storage l = _listings[id];
        if (msg.sender != l.seller) revert NotSeller();
        if (l.status != Status.Delivered) revert WrongStatus();
        if (l.proceedsClaimed) revert NothingToClaim();
        l.proceedsClaimed = true;
        (, uint256 proceeds) = quote(l.paid);
        _payOut(l.payToken, l.seller, proceeds);
        emit ProceedsClaimed(id, l.seller, l.payToken, proceeds);
    }

    /// @notice Buyer takes the payment back when delivery has not happened
    ///         within REFUND_DELAY of the sale.
    function refund(uint256 id) external nonReentrant {
        Listing storage l = _listings[id];
        if (msg.sender != l.buyer) revert NotBuyer();
        if (l.status != Status.Sold) revert WrongStatus();
        if (block.timestamp < uint256(l.soldAt) + REFUND_DELAY) revert RefundTooEarly();
        l.status = Status.Refunded;
        uint256 amount = l.paid;
        l.paid = 0;
        _payOut(l.payToken, l.buyer, amount);
        emit Refunded(id, l.buyer, l.payToken, amount);
    }

    // ----------------------------------------------------------------- fees

    /// @notice Push accrued protocol fees for `payToken` to the fee recipient. Anyone may call.
    function withdrawFees(address payToken) external nonReentrant {
        uint256 amount = accruedFees[payToken];
        if (amount == 0) revert NothingToClaim();
        accruedFees[payToken] = 0;
        _payOut(payToken, feeRecipient, amount);
        emit FeesWithdrawn(payToken, feeRecipient, amount);
    }

    // ------------------------------------------------------------ internals

    function _close(uint256 id, Listing storage l, Status to) private {
        l.status = to;
        if (activeListingOf[l.target] == id) activeListingOf[l.target] = 0;
    }

    function _returnOwnership(Listing storage l) private returns (bool) {
        if (_ownerOf(l.target) != address(this)) return false;
        IOwnable(l.target).transferOwnership(l.seller);
        return true;
    }

    function _ownerOf(address target) private view returns (address) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSelector(IOwnable.owner.selector));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }

    function _pendingOwnerOf(address target) private view returns (address) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSelector(IOwnable2Step.pendingOwner.selector));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }

    function _payOut(address payToken, address to, uint256 amount) private {
        if (payToken == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeCall(payToken, abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        _safeCall(token, abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
    }

    /// @dev Tolerates tokens that return nothing (USDT-style) and rejects a returned `false`.
    function _safeCall(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
