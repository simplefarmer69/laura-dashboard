// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LabRegistry
/// @author LAURA (the StonkBrokers agent swarm), Robinhood Chain 4663
/// @notice Seller-published metadata for Ownership Market listings: a longer
///         description, an image, website, GitHub, socials and audit links,
///         as one JSON string per listing. The market's own 280-byte
///         description stays the on-chain source of truth for the sale; this
///         registry is the storefront layer that any frontend ("The Lab" at
///         laura.stonkbrokers.io/lab or anyone else's) can render.
///
///         Only the seller of a listing may write its metadata, checked live
///         against the market on every write, so a record can never be
///         planted on someone else's listing. Nothing here moves value, and
///         the registry has no owner, admin, pause or upgrade path.
///
/// @dev    Frontends MUST treat metadata as untrusted seller input: render
///         text as text, allow only http(s)/ipfs links, never execute it.
interface IOwnershipMarketListings {
    /// @dev Mirrors OwnershipMarket.Listing (the Status enum encodes as uint8).
    struct Listing {
        address target;
        address seller;
        address buyer;
        address payToken;
        uint256 price;
        uint256 paid;
        uint64 createdAt;
        uint64 soldAt;
        uint8 status;
        bool proceedsClaimed;
        string description;
    }

    function getListing(uint256 id) external view returns (Listing memory);
}

contract LabRegistry {
    /// @notice The Ownership Market whose listings this registry describes. Fixed at deploy.
    address public immutable market;
    /// @notice Maximum byte length of one metadata record (a JSON string).
    uint256 public constant MAX_METADATA_BYTES = 3000;

    struct Record {
        string metadata;
        address setBy;
        uint64 updatedAt;
    }

    mapping(uint256 => Record) private _records;

    event MetadataSet(uint256 indexed id, address indexed target, address indexed seller, string metadata);
    event MetadataCleared(uint256 indexed id, address indexed seller);

    error ZeroAddress();
    error NoListing();
    error NotSeller();
    error MetadataTooLong();

    constructor(address market_) {
        if (market_ == address(0)) revert ZeroAddress();
        market = market_;
    }

    /// @notice Set (or replace) the metadata of listing `id`. Caller must be its seller.
    function setMetadata(uint256 id, string calldata metadata) external {
        if (bytes(metadata).length > MAX_METADATA_BYTES) revert MetadataTooLong();
        IOwnershipMarketListings.Listing memory l = IOwnershipMarketListings(market).getListing(id);
        if (l.seller == address(0)) revert NoListing();
        if (l.seller != msg.sender) revert NotSeller();
        _records[id] = Record({metadata: metadata, setBy: msg.sender, updatedAt: uint64(block.timestamp)});
        emit MetadataSet(id, l.target, msg.sender, metadata);
    }

    /// @notice Remove the metadata of listing `id`. Caller must be its seller.
    function clearMetadata(uint256 id) external {
        IOwnershipMarketListings.Listing memory l = IOwnershipMarketListings(market).getListing(id);
        if (l.seller == address(0)) revert NoListing();
        if (l.seller != msg.sender) revert NotSeller();
        delete _records[id];
        emit MetadataCleared(id, msg.sender);
    }

    /// @notice Metadata of listing `id` (empty string when none was set).
    function getMetadata(uint256 id) external view returns (string memory metadata, address setBy, uint64 updatedAt) {
        Record storage r = _records[id];
        return (r.metadata, r.setBy, r.updatedAt);
    }

    /// @notice Metadata for a range of listing ids, for frontends that render the whole market in one call.
    function getMetadataBatch(uint256 fromId, uint256 toId) external view returns (Record[] memory out) {
        if (toId < fromId) return out;
        uint256 n = toId - fromId + 1;
        out = new Record[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = _records[fromId + i];
        }
    }
}
