"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createWalletClient, custom, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { LAB_CHAIN } from "@/lib/lab/contracts";

/**
 * Minimal injected-wallet connection (MetaMask, Rabby, Coinbase Wallet,
 * Phantom EVM, any EIP-1193 provider). EIP-6963 announcements are collected
 * so multiple installed wallets are all offered; `window.ethereum` is the
 * fallback. No wallet SDKs, no third-party connection service: the page can
 * be hosted anywhere and talks to the chain directly.
 */

export interface WalletOption {
  id: string;
  name: string;
  icon: string | null;
  provider: EIP1193Provider;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

export interface WalletState {
  options: WalletOption[];
  account: Address | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
  client: WalletClient | null;
  onChain: boolean;
  connect: (option?: WalletOption) => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
}

const CHAIN_HEX = `0x${LAB_CHAIN.id.toString(16)}`;

function hexToNumber(v: unknown): number | null {
  if (typeof v === "string" && v.startsWith("0x")) return Number.parseInt(v, 16);
  if (typeof v === "number") return v;
  return null;
}

export function useWallet(): WalletState {
  const [options, setOptions] = useState<WalletOption[]>([]);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<EIP1193Provider | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const found = new Map<string, WalletOption>();
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      if (!detail?.provider) return;
      found.set(detail.info.rdns || detail.info.uuid, {
        id: detail.info.rdns || detail.info.uuid,
        name: detail.info.name,
        icon: detail.info.icon || null,
        provider: detail.provider,
      });
      setOptions([...found.values()]);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const injected = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    const timer = setTimeout(() => {
      if (found.size === 0 && injected) {
        found.set("injected", { id: "injected", name: "Browser wallet", icon: null, provider: injected });
        setOptions([...found.values()]);
      }
    }, 300);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(timer);
    };
  }, []);

  const attach = useCallback((p: EIP1193Provider) => setProvider(p), []);

  useEffect(() => {
    if (!provider) return;
    const onAccounts = (accounts: unknown) => {
      const list = Array.isArray(accounts) ? (accounts as string[]) : [];
      setAccount(list.length > 0 ? (list[0] as Address) : null);
    };
    const onChain = (id: unknown) => setChainId(hexToNumber(id));
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener("accountsChanged", onAccounts);
      provider.removeListener("chainChanged", onChain);
    };
  }, [provider]);

  const connect = useCallback(
    async (option?: WalletOption) => {
      const chosen = option ?? options[0];
      if (!chosen) {
        setError("No browser wallet found. Install MetaMask, Rabby or another EVM wallet, or open this page in your wallet's browser.");
        return;
      }
      setConnecting(true);
      setError(null);
      try {
        const accounts = (await chosen.provider.request({ method: "eth_requestAccounts" })) as string[];
        const id = hexToNumber(await chosen.provider.request({ method: "eth_chainId" }));
        attach(chosen.provider);
        setAccount(accounts.length > 0 ? (accounts[0] as Address) : null);
        setChainId(id);
        try {
          window.localStorage.setItem("lab.wallet", chosen.id);
        } catch {
          /* private mode */
        }
      } catch (err) {
        setError(String((err as { message?: string })?.message ?? err).slice(0, 200));
      } finally {
        setConnecting(false);
      }
    },
    [attach, options],
  );

  /* Silent reconnect to the wallet used last time, when it already authorised this site. */
  useEffect(() => {
    if (account || options.length === 0) return;
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem("lab.wallet");
    } catch {
      remembered = null;
    }
    const option = options.find((o) => o.id === remembered);
    if (!option) return;
    void (async () => {
      try {
        const accounts = (await option.provider.request({ method: "eth_accounts" })) as string[];
        if (accounts.length === 0) return;
        const id = hexToNumber(await option.provider.request({ method: "eth_chainId" }));
        attach(option.provider);
        setAccount(accounts[0] as Address);
        setChainId(id);
      } catch {
        /* wallet locked; the user connects explicitly */
      }
    })();
  }, [account, attach, options]);

  const switchChain = useCallback(async () => {
    if (!provider) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 4902 || code === -32603) {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: CHAIN_HEX,
              chainName: LAB_CHAIN.name,
              nativeCurrency: LAB_CHAIN.nativeCurrency,
              rpcUrls: [...LAB_CHAIN.rpcUrls.default.http],
              blockExplorerUrls: [LAB_CHAIN.blockExplorers.default.url],
            },
          ],
        });
      } else {
        throw err;
      }
    }
    setChainId(hexToNumber(await provider.request({ method: "eth_chainId" })));
  }, [provider]);

  const disconnect = useCallback(() => {
    setProvider(null);
    setAccount(null);
    setChainId(null);
    try {
      window.localStorage.removeItem("lab.wallet");
    } catch {
      /* ignore */
    }
  }, []);

  const client = useMemo(() => {
    if (!provider || !account) return null;
    return createWalletClient({ account, chain: LAB_CHAIN, transport: custom(provider) });
  }, [account, provider]);

  return {
    options,
    account,
    chainId,
    connecting,
    error,
    client,
    onChain: chainId === LAB_CHAIN.id,
    connect,
    disconnect,
    switchChain,
  };
}
