// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OwnershipMarket, IOwnable} from "../../../src/lib/forge/contracts/OwnershipMarket.sol";

/* Minimal cheatcode surface so this harness needs no external library. */
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

abstract contract Base {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function eq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    function eq(address a, address b, string memory what) internal pure {
        require(a == b, what);
    }
}

/* ------------------------------------------------------------------ mocks */

contract Ownable {
    address public owner;

    constructor(address o) {
        owner = o;
    }

    function transferOwnership(address n) external {
        require(msg.sender == owner, "not owner");
        owner = n;
    }
}

contract Ownable2Step {
    address public owner;
    address public pendingOwner;

    constructor(address o) {
        owner = o;
    }

    function transferOwnership(address n) external {
        require(msg.sender == owner, "not owner");
        pendingOwner = n;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending");
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}

/* Hands over to the market once, then ignores every further transfer. */
contract LyingOwnable {
    address public owner;
    bool moved;

    constructor(address o) {
        owner = o;
    }

    function transferOwnership(address n) external {
        if (moved) return;
        moved = true;
        owner = n;
    }
}

/* Re-enters the market from transferOwnership. */
contract ReentrantOwnable {
    address public owner;
    OwnershipMarket market;
    uint256 id;

    constructor(address o, OwnershipMarket m) {
        owner = o;
        market = m;
    }

    function arm(uint256 id_) external {
        id = id_;
    }

    function transferOwnership(address n) external {
        require(msg.sender == owner, "not owner");
        if (msg.sender == address(market) && id != 0) {
            market.deliver(id); // must hit Reentrancy()
        }
        owner = n;
    }
}

contract ERC20Mock {
    string public name = "Mock";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public feeBps; // fee-on-transfer simulation
    bool public silent; // USDT-style: no return value

    constructor(uint256 feeBps_, bool silent_) {
        feeBps = feeBps_;
        silent = silent_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function _move(address f, address t, uint256 a) internal {
        require(balanceOf[f] >= a, "bal");
        uint256 fee = (a * feeBps) / 10_000;
        balanceOf[f] -= a;
        balanceOf[t] += a - fee;
    }

    function transfer(address t, uint256 a) external returns (bool) {
        _move(msg.sender, t, a);
        if (silent) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a;
        _move(f, t, a);
        if (silent) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }
}

contract FalseERC20 {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract Rejector {
    receive() external payable {
        revert("no");
    }
}

/* ------------------------------------------------------------------ tests */

contract OwnershipMarketTest is Base {
    OwnershipMarket market;
    address feeRecipient = address(0xFEE);
    address seller = address(0xA11CE);
    address buyer = address(0xB0B);
    address rando = address(0xC0FFEE);

    function setUp() public {
        market = new OwnershipMarket(feeRecipient);
        vm.deal(seller, 100 ether);
        vm.deal(buyer, 100 ether);
        vm.deal(rando, 100 ether);
    }

    function _listNative(Ownable t, uint256 price) internal returns (uint256 id) {
        vm.startPrank(seller);
        id = market.createListing(address(t), address(0), price, "An NFT collection with 4,444 minted");
        t.transferOwnership(address(market));
        vm.stopPrank();
    }

    /* ---- constructor */

    function test_constructorRejectsZeroFeeRecipient() public {
        vm.expectRevert(OwnershipMarket.ZeroAddress.selector);
        new OwnershipMarket(address(0));
    }

    function test_feeIsOnePercent() public view {
        (uint256 fee, uint256 proceeds) = market.quote(10 ether);
        eq(fee, 0.1 ether, "fee");
        eq(proceeds, 9.9 ether, "proceeds");
        eq(market.FEE_BPS(), 100, "bps");
    }

    /* ---- listing */

    function test_happyPathNative() public {
        Ownable t = new Ownable(seller);
        uint256 id = _listNative(t, 10 ether);
        require(market.isEscrowed(id), "escrowed");
        eq(market.activeListingOf(address(t)), id, "active");

        vm.prank(buyer);
        market.buy{value: 10 ether}(id, address(0), 10 ether);
        eq(uint256(market.getListing(id).status), uint256(OwnershipMarket.Status.Sold), "sold");

        vm.prank(rando); // anyone delivers
        market.deliver(id);
        eq(t.owner(), buyer, "buyer owns");
        eq(market.activeListingOf(address(t)), 0, "cleared");
        eq(market.accruedFees(address(0)), 0.1 ether, "fee booked");

        uint256 before = seller.balance;
        vm.prank(seller);
        market.claimProceeds(id);
        eq(seller.balance - before, 9.9 ether, "seller paid");

        vm.prank(rando);
        market.withdrawFees(address(0));
        eq(feeRecipient.balance, 0.1 ether, "fee paid");
        eq(address(market).balance, 0, "market drained");
    }

    function test_happyPathERC20() public {
        ERC20Mock usd = new ERC20Mock(0, false);
        usd.mint(buyer, 1_000e6);
        Ownable t = new Ownable(seller);
        vm.startPrank(seller);
        uint256 id = market.createListing(address(t), address(usd), 500e6, "vault");
        t.transferOwnership(address(market));
        vm.stopPrank();

        vm.startPrank(buyer);
        usd.approve(address(market), 500e6);
        market.buy(id, address(usd), 500e6);
        vm.stopPrank();
        eq(usd.balanceOf(address(market)), 500e6, "escrowed funds");

        market.deliver(id);
        vm.prank(seller);
        market.claimProceeds(id);
        eq(usd.balanceOf(seller), 495e6, "seller net");
        market.withdrawFees(address(usd));
        eq(usd.balanceOf(feeRecipient), 5e6, "fee");
    }

    function test_feeOnTransferTokenUsesReceivedAmount() public {
        ERC20Mock tax = new ERC20Mock(1_000, false); // 10% burn on transfer
        tax.mint(buyer, 100e18);
        Ownable t = new Ownable(seller);
        vm.startPrank(seller);
        uint256 id = market.createListing(address(t), address(tax), 100e18, "x");
        t.transferOwnership(address(market));
        vm.stopPrank();
        vm.startPrank(buyer);
        tax.approve(address(market), 100e18);
        market.buy(id, address(tax), 100e18);
        vm.stopPrank();
        eq(market.getListing(id).paid, 90e18, "paid is what arrived");
        market.deliver(id);
        eq(market.accruedFees(address(tax)), 0.9e18, "fee on received");
    }

    function test_silentTokenAccepted_falseTokenRejected() public {
        ERC20Mock usdt = new ERC20Mock(0, true);
        usdt.mint(buyer, 10e6);
        Ownable t = new Ownable(seller);
        vm.startPrank(seller);
        uint256 id = market.createListing(address(t), address(usdt), 10e6, "x");
        t.transferOwnership(address(market));
        vm.stopPrank();
        vm.startPrank(buyer);
        usdt.approve(address(market), 10e6);
        market.buy(id, address(usdt), 10e6);
        vm.stopPrank();
        market.deliver(id);
        vm.prank(seller);
        market.claimProceeds(id);
        eq(usdt.balanceOf(seller), 9.9e6, "silent token paid out");

        FalseERC20 bad = new FalseERC20();
        Ownable t2 = new Ownable(seller);
        vm.startPrank(seller);
        uint256 id2 = market.createListing(address(t2), address(bad), 1, "x");
        t2.transferOwnership(address(market));
        vm.stopPrank();
        vm.prank(buyer);
        vm.expectRevert(OwnershipMarket.TransferFailed.selector);
        market.buy(id2, address(bad), 1);
    }

    function test_listRequiresCurrentOwner_noFrontRunOfEscrowedContracts() public {
        Ownable t = new Ownable(seller);
        vm.prank(rando);
        vm.expectRevert(OwnershipMarket.NotTargetOwner.selector);
        market.createListing(address(t), address(0), 1 ether, "steal");

        /* Ownership already sitting at the market with no listing: nobody can claim it. */
        vm.prank(seller);
        t.transferOwnership(address(market));
        vm.prank(rando);
        vm.expectRevert(OwnershipMarket.NotTargetOwner.selector);
        market.createListing(address(t), address(0), 1, "steal");
        vm.prank(seller);
        vm.expectRevert(OwnershipMarket.NotTargetOwner.selector);
        market.createListing(address(t), address(0), 1, "late");
    }

    function test_listValidation() public {
        Ownable t = new Ownable(seller);
        vm.startPrank(seller);
        vm.expectRevert(OwnershipMarket.ZeroPrice.selector);
        market.createListing(address(t), address(0), 0, "x");
        vm.expectRevert(OwnershipMarket.NotAContract.selector);
        market.createListing(rando, address(0), 1, "x");
        vm.expectRevert(OwnershipMarket.NotAContract.selector);
        market.createListing(address(t), rando, 1, "x");
        bytes memory long = new bytes(281);
        vm.expectRevert(OwnershipMarket.DescriptionTooLong.selector);
        market.createListing(address(t), address(0), 1, string(long));
        market.createListing(address(t), address(0), 1, "ok");
        vm.expectRevert(OwnershipMarket.AlreadyListed.selector);
        market.createListing(address(t), address(0), 1, "dup");
        vm.stopPrank();
    }

    function test_buyRequiresEscrowAndExactTerms() public {
        Ownable t = new Ownable(seller);
        vm.prank(seller);
        uint256 id = market.createListing(address(t), address(0), 1 ether, "x");
        vm.prank(buyer);
        vm.expectRevert(OwnershipMarket.NotEscrowed.selector);
        market.buy{value: 1 ether}(id, address(0), 1 ether);

        vm.prank(seller);
        t.transferOwnership(address(market));
        vm.prank(buyer);
        vm.expectRevert(OwnershipMarket.WrongValue.selector);
        market.buy{value: 0.5 ether}(id, address(0), 1 ether);

        /* Seller edits the price; a buyer quoting the old terms is protected. */
        vm.prank(seller);
        market.updateListing(id, address(0), 2 ether, "pricier");
        vm.prank(buyer);
        vm.expectRevert(OwnershipMarket.ListingChanged.selector);
        market.buy{value: 1 ether}(id, address(0), 1 ether);
        vm.prank(buyer);
        market.buy{value: 2 ether}(id, address(0), 2 ether);
        vm.prank(buyer);
        vm.expectRevert(OwnershipMarket.WrongStatus.selector);
        market.buy{value: 2 ether}(id, address(0), 2 ether);
    }

    function test_cancelReturnsOwnership() public {
        Ownable t = new Ownable(seller);
        uint256 id = _listNative(t, 1 ether);
        vm.prank(rando);
        vm.expectRevert(OwnershipMarket.NotSeller.selector);
        market.cancel(id);
        vm.prank(seller);
        market.cancel(id);
        eq(t.owner(), seller, "returned");
        eq(market.activeListingOf(address(t)), 0, "cleared");
        vm.prank(buyer);
        vm.expectRevert(OwnershipMarket.WrongStatus.selector);
        market.buy{value: 1 ether}(id, address(0), 1 ether);
    }

    function test_cancelBeforeEscrowIsFine() public {
        Ownable t = new Ownable(seller);
        vm.startPrank(seller);
        uint256 id = market.createListing(address(t), address(0), 1 ether, "x");
        market.cancel(id);
        vm.stopPrank();
        eq(t.owner(), seller, "untouched");
    }

    function test_expireStaleListing() public {
        Ownable t = new Ownable(seller);
        vm.startPrank(seller);
        uint256 id = market.createListing(address(t), address(0), 1 ether, "x");
        vm.expectRevert(OwnershipMarket.NotStale.selector);
        market.expire(id);
        t.transferOwnership(rando); // sold elsewhere
        vm.stopPrank();
        vm.prank(buyer);
        market.expire(id);
        eq(market.activeListingOf(address(t)), 0, "freed");
        vm.prank(rando);
        market.createListing(address(t), address(0), 1, "relist by new owner");
    }

    function test_refundAfterDelayThenSellerReclaims() public {
        Ownable t = new Ownable(seller);
        uint256 id = _listNative(t, 3 ether);
        vm.prank(buyer);
        market.buy{value: 3 ether}(id, address(0), 3 ether);

        vm.prank(buyer);
        vm.expectRevert(OwnershipMarket.RefundTooEarly.selector);
        market.refund(id);
        vm.prank(rando);
        vm.expectRevert(OwnershipMarket.NotBuyer.selector);
        market.refund(id);

        vm.warp(block.timestamp + 1 days);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        market.refund(id);
        eq(buyer.balance - before, 3 ether, "refunded in full, no fee");
        eq(market.accruedFees(address(0)), 0, "no fee on refund");

        vm.expectRevert(OwnershipMarket.WrongStatus.selector);
        market.deliver(id);
        vm.prank(seller);
        vm.expectRevert(OwnershipMarket.WrongStatus.selector);
        market.claimProceeds(id);

        vm.prank(seller);
        market.cancel(id);
        eq(t.owner(), seller, "ownership back");
    }

    function test_noRefundAfterDelivery_noDoubleClaim() public {
        Ownable t = new Ownable(seller);
        uint256 id = _listNative(t, 1 ether);
        vm.prank(buyer);
        market.buy{value: 1 ether}(id, address(0), 1 ether);
        market.deliver(id);
        vm.warp(block.timestamp + 2 days);
        vm.prank(buyer);
        vm.expectRevert(OwnershipMarket.WrongStatus.selector);
        market.refund(id);
        vm.startPrank(seller);
        market.claimProceeds(id);
        vm.expectRevert(OwnershipMarket.NothingToClaim.selector);
        market.claimProceeds(id);
        vm.stopPrank();
        vm.expectRevert(OwnershipMarket.WrongStatus.selector);
        market.deliver(id);
    }

    function test_ownable2StepFlow() public {
        Ownable2Step t = new Ownable2Step(seller);
        vm.startPrank(seller);
        uint256 id = market.createListing(address(t), address(0), 1 ether, "2step");
        t.transferOwnership(address(market));
        vm.stopPrank();
        require(!market.isEscrowed(id), "pending only");
        vm.prank(rando);
        market.acceptEscrow(id);
        require(market.isEscrowed(id), "escrowed");
        vm.prank(buyer);
        market.buy{value: 1 ether}(id, address(0), 1 ether);
        market.deliver(id);
        eq(t.pendingOwner(), buyer, "pending to buyer");
        vm.prank(buyer);
        t.acceptOwnership();
        eq(t.owner(), buyer, "buyer owns");
        vm.prank(seller);
        market.claimProceeds(id);
    }

    function test_deliveryFailsWhenTargetDoesNotHandOver() public {
        LyingOwnable t = new LyingOwnable(seller);
        vm.startPrank(seller);
        uint256 id = market.createListing(address(t), address(0), 1 ether, "liar");
        t.transferOwnership(address(market));
        vm.stopPrank();
        vm.prank(buyer);
        market.buy{value: 1 ether}(id, address(0), 1 ether);
        vm.expectRevert(OwnershipMarket.DeliveryFailed.selector);
        market.deliver(id);
        /* Buyer is made whole after the delay; the seller's contract stays with the market
           until the seller cancels (which the lying mock will also ignore -- its problem). */
        vm.warp(block.timestamp + 1 days);
        vm.prank(buyer);
        market.refund(id);
        eq(buyer.balance, 100 ether, "refunded");
    }

    function test_reentrancyFromTargetIsBlocked() public {
        ReentrantOwnable t = new ReentrantOwnable(seller, market);
        vm.startPrank(seller);
        uint256 id = market.createListing(address(t), address(0), 1 ether, "reenter");
        t.transferOwnership(address(market));
        vm.stopPrank();
        t.arm(id);
        vm.prank(buyer);
        market.buy{value: 1 ether}(id, address(0), 1 ether);
        vm.expectRevert(OwnershipMarket.Reentrancy.selector); // inner deliver reverts and bubbles
        market.deliver(id);
        eq(uint256(market.getListing(id).status), uint256(OwnershipMarket.Status.Sold), "still sold");
    }

    function test_nativePayoutToRejectingSellerReverts() public {
        Rejector r = new Rejector();
        Ownable t = new Ownable(address(r));
        vm.startPrank(address(r));
        uint256 id = market.createListing(address(t), address(0), 1 ether, "x");
        t.transferOwnership(address(market));
        vm.stopPrank();
        vm.prank(buyer);
        market.buy{value: 1 ether}(id, address(0), 1 ether);
        market.deliver(id);
        vm.prank(address(r));
        vm.expectRevert(OwnershipMarket.TransferFailed.selector);
        market.claimProceeds(id);
        /* Funds stay claimable; nothing else is affected. */
        market.withdrawFees(address(0));
        eq(feeRecipient.balance, 0.01 ether, "fee still flows");
    }

    function test_withdrawFeesRequiresBalance() public {
        vm.expectRevert(OwnershipMarket.NothingToClaim.selector);
        market.withdrawFees(address(0));
    }

    function test_marketHasNoOwner() public {
        (bool ok, ) = address(market).call(abi.encodeWithSignature("owner()"));
        require(!ok, "market must not expose owner()");
        (ok, ) = address(market).call(abi.encodeWithSignature("transferOwnership(address)", rando));
        require(!ok, "market must not expose transferOwnership()");
        (ok, ) = address(market).call(abi.encodeWithSignature("setFeeRecipient(address)", rando));
        require(!ok, "no fee recipient setter");
    }
}
