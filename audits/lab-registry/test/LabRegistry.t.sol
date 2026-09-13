// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OwnershipMarket} from "../../../src/lib/forge/contracts/OwnershipMarket.sol";
import {LabRegistry} from "../../../src/lib/forge/contracts/LabRegistry.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectEmit() external;
    function warp(uint256) external;
    function deal(address, uint256) external;
}

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

contract LabRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant TREASURY = address(0xFEE);
    address constant SELLER = address(0xA11CE);
    address constant STRANGER = address(0xB0B);

    OwnershipMarket market;
    LabRegistry registry;
    Ownable target;
    uint256 id;

    event MetadataSet(uint256 indexed id, address indexed target, address indexed seller, string metadata);

    function setUp() public {
        market = new OwnershipMarket(TREASURY);
        registry = new LabRegistry(address(market));
        target = new Ownable(SELLER);
        vm.prank(SELLER);
        id = market.createListing(address(target), address(0), 1 ether, "a contract");
    }

    function test_constructorRejectsZeroMarket() public {
        vm.expectRevert(LabRegistry.ZeroAddress.selector);
        new LabRegistry(address(0));
    }

    function test_sellerSetsAndReadsMetadata() public {
        string memory meta = '{"name":"Tip Jar","image":"https://example.com/a.png","github":"https://github.com/x/y"}';
        vm.warp(1_000);
        vm.prank(SELLER);
        vm.expectEmit();
        emit MetadataSet(id, address(target), SELLER, meta);
        registry.setMetadata(id, meta);
        (string memory got, address setBy, uint64 at) = registry.getMetadata(id);
        require(keccak256(bytes(got)) == keccak256(bytes(meta)), "metadata");
        require(setBy == SELLER, "setBy");
        require(at == 1_000, "updatedAt");
    }

    function test_sellerReplacesMetadata() public {
        vm.prank(SELLER);
        registry.setMetadata(id, "v1");
        vm.prank(SELLER);
        registry.setMetadata(id, "v2");
        (string memory got, , ) = registry.getMetadata(id);
        require(keccak256(bytes(got)) == keccak256("v2"), "replaced");
    }

    function test_strangerCannotSet() public {
        vm.prank(STRANGER);
        vm.expectRevert(LabRegistry.NotSeller.selector);
        registry.setMetadata(id, "planted");
    }

    function test_buyerCannotSetEvenAfterDelivery() public {
        vm.prank(SELLER);
        target.transferOwnership(address(market));
        address buyer = address(0xBEEF);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        market.buy{value: 1 ether}(id, address(0), 1 ether);
        market.deliver(id);
        require(target.owner() == buyer, "delivered");
        vm.prank(buyer);
        vm.expectRevert(LabRegistry.NotSeller.selector);
        registry.setMetadata(id, "buyer text");
    }

    function test_unknownListingReverts() public {
        vm.prank(SELLER);
        vm.expectRevert(LabRegistry.NoListing.selector);
        registry.setMetadata(999, "x");
    }

    function test_tooLongReverts() public {
        bytes memory big = new bytes(registry.MAX_METADATA_BYTES() + 1);
        vm.prank(SELLER);
        vm.expectRevert(LabRegistry.MetadataTooLong.selector);
        registry.setMetadata(id, string(big));
    }

    function test_maxLengthAccepted() public {
        bytes memory big = new bytes(registry.MAX_METADATA_BYTES());
        vm.prank(SELLER);
        registry.setMetadata(id, string(big));
        (string memory got, , ) = registry.getMetadata(id);
        require(bytes(got).length == registry.MAX_METADATA_BYTES(), "stored");
    }

    function test_sellerClears() public {
        vm.prank(SELLER);
        registry.setMetadata(id, "v1");
        vm.prank(SELLER);
        registry.clearMetadata(id);
        (string memory got, address setBy, ) = registry.getMetadata(id);
        require(bytes(got).length == 0 && setBy == address(0), "cleared");
    }

    function test_strangerCannotClear() public {
        vm.prank(SELLER);
        registry.setMetadata(id, "v1");
        vm.prank(STRANGER);
        vm.expectRevert(LabRegistry.NotSeller.selector);
        registry.clearMetadata(id);
    }

    function test_batchRead() public {
        Ownable t2 = new Ownable(SELLER);
        vm.prank(SELLER);
        uint256 id2 = market.createListing(address(t2), address(0), 2 ether, "second");
        vm.prank(SELLER);
        registry.setMetadata(id2, "two");
        LabRegistry.Record[] memory out = registry.getMetadataBatch(id, id2);
        require(out.length == 2, "len");
        require(bytes(out[0].metadata).length == 0, "first empty");
        require(keccak256(bytes(out[1].metadata)) == keccak256("two"), "second set");
        LabRegistry.Record[] memory none = registry.getMetadataBatch(5, 3);
        require(none.length == 0, "inverted range");
    }

    function test_metadataSurvivesSaleAndOnlySellerKeepsWriting() public {
        vm.prank(SELLER);
        registry.setMetadata(id, "before sale");
        vm.prank(SELLER);
        target.transferOwnership(address(market));
        address buyer = address(0xBEEF);
        vm.prank(SELLER);
        registry.setMetadata(id, "still seller");
        (string memory got, , ) = registry.getMetadata(id);
        require(keccak256(bytes(got)) == keccak256("still seller"), "seller keeps writing");
        vm.prank(buyer);
        vm.expectRevert(LabRegistry.NotSeller.selector);
        registry.setMetadata(id, "not mine");
    }
}
