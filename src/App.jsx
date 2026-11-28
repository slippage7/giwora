import { useEffect, useState } from 'react';

import {
  createWalletClient,
  createPublicClient,
  custom,
  defineChain,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  keccak256,
  parseUnits,
} from 'viem';

import {
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAutoRoute,
  resolveAmmoraFinalizedHead,
  verifyAmmoraV4CoreAtBlock,
  getAmmoraV4NextConfigId,
  getAmmoraV4ConfigAtBlock,
  AmmoraV4MigrationMode,
  buildSingleSegmentCurve,
  assertAmmoraV4Config,
  concentratedDepositQuote,
  buildCreateAmmoraV4Config,
  parseAmmoraV4ConfigCreatedReceipt,
  buildCreateAmmoraV4Launch,
  parseAmmoraV4LaunchCreatedReceipt,
} from '@ammora-protocol/sdk';

import './App.css';
import {
  checkLogoFile,
  formatBytes,
  normalizeLink,
  uploadLogo,
  uploadMetadata,
} from './metadata.js';

const deployment = giwaSepoliaAutoRouteDeployment;
const contracts = deployment.contracts.launch;

const CHAIN_ID = 91342;
const CHAIN_HEX = '0x164ce';
const TEMPLATE_ID = 24n;

const giwaChain = defineChain({
  id: CHAIN_ID,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: {
    default: {
      http: [deployment.chain.rpcUrls[0]],
    },
  },
  testnet: true,
});

const sdkReady =
  deployment.chain.id === CHAIN_ID && contracts.protocolVersion === 4;

const erc20DecimalsAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
];

function shortAddress(value) {
  if (!value || typeof value !== 'string') return '—';
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function errorMessage(error) {
  return (
    error?.shortMessage ||
    error?.details ||
    error?.message ||
    'An unexpected error occurred.'
  );
}

function jsonStringify(value) {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === 'bigint' ? item.toString() : item),
    2
  );
}

function pacedTransport(provider, interval = 650) {
  let tail = Promise.resolve();
  let nextStart = 0;

  return custom({
    request: (args) => {
      const result = tail.then(async () => {
        const wait = Math.max(0, nextStart - Date.now());

        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }

        try {
          return await provider.request(args);
        } finally {
          nextStart = Date.now() + interval;
        }
      });

      tail = result.catch(() => undefined);
      return result;
    },
  });
}

/**
 * Minimal EIP-1193 style provider backed by the public GIWA Sepolia RPC.
 * Used only for read-only registry queries when no wallet is available.
 */
function publicRpcProvider(url) {
  let nextId = 0;

  return {
    request: async ({ method, params }) => {
      let response;

      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Never leave a page stuck on "Loading…" if the RPC hangs.
          signal:
            typeof AbortSignal !== 'undefined' && AbortSignal.timeout
              ? AbortSignal.timeout(20000)
              : undefined,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++nextId,
            method,
            params: params ?? [],
          }),
        });
      } catch {
        throw new Error(
          'Could not reach the GIWA Sepolia RPC. Connect your wallet and try again.'
        );
      }

      if (!response.ok) {
        throw new Error(`GIWA Sepolia RPC returned HTTP ${response.status}.`);
      }

      const payload = await response.json();

      if (payload.error) {
        const failure = new Error(payload.error.message || 'RPC error');
        failure.code = payload.error.code;
        throw failure;
      }

      return payload.result;
    },
  };
}

/**
 * The confirmed Configuration is remembered in this browser (per wallet and
 * chain) so a page refresh does not lose it. Only plain strings are stored;
 * Token Launch still re-verifies everything against the chain.
 */
const savedConfigKey = (address) =>
  `giwora:config:${CHAIN_ID}:${String(address).toLowerCase()}`;

function loadSavedConfig(address) {
  try {
    const raw = window.localStorage.getItem(savedConfigKey(address));
    if (!raw) return null;

    const value = JSON.parse(raw);

    if (
      value &&
      /^\d+$/.test(String(value.configId)) &&
      /^0x[0-9a-fA-F]{64}$/.test(String(value.configHash))
    ) {
      return {
        configId: String(value.configId),
        configHash: String(value.configHash),
        owner: String(value.owner || ''),
        feeClaimer: String(value.feeClaimer || ''),
        blockNumber: String(value.blockNumber || ''),
        transactionHash: String(value.transactionHash || ''),
      };
    }
  } catch {
    // storage unavailable or corrupted: behave as if nothing was saved
  }

  return null;
}

function saveConfig(address, value) {
  try {
    window.localStorage.setItem(
      savedConfigKey(address),
      JSON.stringify({
        configId: String(value.configId),
        configHash: String(value.configHash),
        owner: String(value.owner),
        feeClaimer: String(value.feeClaimer),
        blockNumber: String(value.blockNumber),
        transactionHash: String(value.transactionHash),
      })
    );
  } catch {
    // storage unavailable: the configuration simply is not remembered
  }
}

function clearSavedConfig(address) {
  try {
    window.localStorage.removeItem(savedConfigKey(address));
  } catch {
    // nothing to clear
  }
}

/**
 * Ammora's official concentrated template derivation.
 * Recalculates curve, migration reserve, destination liquidity and total supply.
 */
function deriveConfigFromTemplate(
  template,
  saleSupply,
  migrationQuoteThreshold
) {
  if (saleSupply <= 0n || migrationQuoteThreshold <= 0n) {
    throw new Error('Sale supply and graduation threshold must be positive.');
  }

  if (template.config.migrationMode !== AmmoraV4MigrationMode.Concentrated) {
    throw new Error(
      'This GIWORA Configuration Studio currently supports the concentrated graduation template only.'
    );
  }

  const curve = buildSingleSegmentCurve(
    template.config.startSqrtPrice,
    saleSupply,
    migrationQuoteThreshold
  );

  const segment = curve[0];

  if (!segment) {
    throw new Error('The SDK did not return a curve segment.');
  }

  const range = {
    sqrtPriceX64: segment.upperSqrtPrice,
    sqrtMinPriceX64: segment.lowerSqrtPrice,
    sqrtMaxPriceX64: segment.upperSqrtPrice * 2n,
  };

  const quoteFee =
    (migrationQuoteThreshold * BigInt(template.config.migrationQuoteFeeBps)) /
    10000n;

  const quoteAfterFee = migrationQuoteThreshold - quoteFee;

  const destination = concentratedDepositQuote(range, {
    quoteAmount: quoteAfterFee,
  });

  const vesting = template.config.lockedBaseVesting;

  const lockedBase =
    vesting.cliffUnlockAmount +
    vesting.amountPerPeriod * BigInt(vesting.numberOfPeriods);

  const config = {
    ...template.config,
    totalSupply: saleSupply + destination.baseAmount + lockedBase,
    migrationQuoteThreshold,
    migrationBaseThreshold: destination.baseAmount,
    postMigrationSqrtMinPrice: range.sqrtMinPriceX64,
    postMigrationSqrtMaxPrice: range.sqrtMaxPriceX64,
    postMigrationLiquidity: destination.liquidity,
  };

  assertAmmoraV4Config(config, curve);

  return {
    config,
    curve,
    economics: {
      saleAllocationRaw: saleSupply,
      grossMigrationBaseRaw: destination.baseAmount,
      grossMigrationQuoteRaw: destination.quoteAmount,
      migrationQuoteFeeRaw: quoteFee,
      quoteSurplusToProtocolRaw: quoteAfterFee - destination.quoteAmount,
      lockedBaseRaw: lockedBase,
      totalSupplyRaw: config.totalSupply,
    },
  };
}

/**
 * Create a new team Config plan.
 * All four team roles use the currently connected wallet.
 */
function planGIWORAConfig(
  template,
  account,
  saleSupply,
  quoteThreshold,
  blockNumber
) {
  const owner = getAddress(account);

  const derived = deriveConfigFromTemplate(
    template,
    saleSupply,
    quoteThreshold
  );

  const config = {
    ...derived.config,
    partnerRecipient: owner,
    leftoverReceiver: owner,
    liquidityDistribution: {
      ...derived.config.liquidityDistribution,
      partner: owner,
    },
  };

  assertAmmoraV4Config(config, derived.curve);

  const built = buildCreateAmmoraV4Config(config, derived.curve, owner);

  const transaction = {
    to: contracts.configRegistry,
    ...built,
  };

  const reviewHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes' },
      ],
      [BigInt(CHAIN_ID), transaction.to, 0n, transaction.data]
    )
  );

  return {
    config,
    curve: derived.curve,
    economics: derived.economics,
    transaction,
    reviewHash,
    templateId: template.configId.toString(),
    templateHash: template.configHash,
    blockNumber: blockNumber.toString(),
    recipients: {
      configOwner: owner,
      partnerRecipient: owner,
      liquidityPartner: owner,
      leftoverReceiver: owner,
    },
  };
}

function amount(value, decimals, label) {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) {
    throw new Error(`${label} must be a valid positive decimal amount.`);
  }

  const fraction = value.split('.')[1] || '';

  if (fraction.length > decimals) {
    throw new Error(`${label} supports at most ${decimals} decimal places.`);
  }

  const parsed = parseUnits(value.trim(), decimals);

  if (parsed <= 0n) {
    throw new Error(`${label} must be greater than zero.`);
  }

  return parsed;
}

const NAV_ITEMS = [
  { id: 'Overview', label: 'Overview' },
  { id: 'Registry', label: 'Registry' },
  { id: 'Config Studio', label: 'Config Studio' },
  { id: 'Token Launch', label: 'Token Launch' },
];

function BondingCurve() {
  return (
    <svg
      className="curve-svg"
      viewBox="0 0 480 340"
      role="presentation"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="gw-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g className="curve-grid">
        {[60, 120, 180, 240, 300].map((y) => (
          <line key={`h${y}`} x1="24" x2="456" y1={y} y2={y} />
        ))}
        {[96, 168, 240, 312, 384].map((x) => (
          <line key={`v${x}`} y1="24" y2="312" x1={x} x2={x} />
        ))}
      </g>

      <path
        className="curve-area"
        d="M24 308 C 150 304, 240 276, 300 202 S 410 70, 456 36 L 456 312 L 24 312 Z"
        fill="url(#gw-area)"
      />
      <path
        className="curve-line"
        d="M24 308 C 150 304, 240 276, 300 202 S 410 70, 456 36"
      />

      <line className="curve-threshold" x1="300" x2="300" y1="24" y2="312" />
      <circle className="curve-node-ring" cx="300" cy="202" r="13" />
      <circle className="curve-node" cx="300" cy="202" r="5.5" />
      <circle className="curve-start" cx="24" cy="308" r="4" />

      <text className="curve-label" x="312" y="44">
        GRADUATION
      </text>
      <text className="curve-label dim" x="30" y="296">
        SALE CURVE
      </text>
    </svg>
  );
}

/**
 * Decorative "G in orbit" emblem. Size is controlled from CSS through the
 * --orbit-size custom property, so one component serves every placement.
 */
function OrbitEmblem({ className = '', core = true }) {
  return (
    <div className={`orbit ${className}`.trim()} aria-hidden="true">
      <span className="orbit-glow"></span>

      <span className="orbit-ring ring-outer">
        <i className="orbit-planet planet-sm"></i>
      </span>
      <span className="orbit-ring ring-mid">
        <i className="orbit-planet planet-hollow"></i>
      </span>
      <span className="orbit-ring ring-inner">
        <i className="orbit-planet planet-lg"></i>
      </span>

      <span className="orbit-spark spark-a"></span>
      <span className="orbit-spark spark-b"></span>
      <span className="orbit-spark spark-c"></span>

      {core && (
        <span className="orbit-core">
          <b>G</b>
        </span>
      )}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState('Overview');

  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(null);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const [configCount, setConfigCount] = useState('');
  const [blockNumber, setBlockNumber] = useState('');
  const [configs, setConfigs] = useState([]);
  const [readStatus, setReadStatus] = useState('idle');
  const [countStatus, setCountStatus] = useState('loading');

  const [selectedId, setSelectedId] = useState('24');
  const [selectedConfig, setSelectedConfig] = useState(null);

  const [saleSupply, setSaleSupply] = useState('1000000');
  const [quoteThreshold, setQuoteThreshold] = useState('0.001');
  const [quoteDecimals, setQuoteDecimals] = useState(null);

  const [preview, setPreview] = useState(null);
  const [configStatus, setConfigStatus] = useState('idle');
  const [createdConfig, setCreatedConfig] = useState(null);

  const [tokenName, setTokenName] = useState('');
  const [tokenSymbol, setTokenSymbol] = useState('');
  const [tokenDescription, setTokenDescription] = useState('');
  const [tokenWebsite, setTokenWebsite] = useState('');
  const [tokenX, setTokenX] = useState('');
  const [tokenTelegram, setTokenTelegram] = useState('');
  const [metadataURI, setMetadataURI] = useState('');
  const [metaMode, setMetaMode] = useState('form'); // 'form' | 'uri'
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreview, setLogoPreview] = useState('');
  const [logoError, setLogoError] = useState('');
  const [logoDragging, setLogoDragging] = useState(false);
  const [launchStep, setLaunchStep] = useState('');

  const [launchStatus, setLaunchStatus] = useState('idle');
  const [createdLaunch, setCreatedLaunch] = useState(null);

  const connected = Boolean(account);
  const correctNetwork = chainId === CHAIN_ID;

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;

    provider
      .request({ method: 'eth_accounts' })
      .then((accounts) => setAccount(accounts?.[0] || ''))
      .catch(() => {});

    provider
      .request({ method: 'eth_chainId' })
      .then((id) => setChainId(Number.parseInt(id, 16)))
      .catch(() => {});

    const onAccountsChanged = (accounts) => {
      setAccount(accounts?.[0] || '');
      setPreview(null);
      setCreatedConfig(null);
      setCreatedLaunch(null);
      setConfigStatus('idle');
      setLaunchStatus('idle');
    };

    const onChainChanged = (id) => {
      setChainId(Number.parseInt(id, 16));
      setConfigs([]);
      setSelectedConfig(null);
      setConfigCount('');
      setPreview(null);
      setCreatedConfig(null);
      setCreatedLaunch(null);
      setConfigStatus('idle');
      setLaunchStatus('idle');
      setReadStatus('idle');
    };

    provider.on?.('accountsChanged', onAccountsChanged);
    provider.on?.('chainChanged', onChainChanged);

    return () => {
      provider.removeListener?.('accountsChanged', onAccountsChanged);
      provider.removeListener?.('chainChanged', onChainChanged);
    };
  }, []);

  // Bring back this wallet's confirmed Configuration after a page refresh.
  useEffect(() => {
    if (!account || chainId !== CHAIN_ID) return;

    const saved = loadSavedConfig(account);

    if (saved) {
      setCreatedConfig((current) => current ?? saved);
    }
  }, [account, chainId]);

  // Load the registry size once on open so the Overview stat shows a number
  // without any wallet. If this fails the Registry page still works on demand.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { client, block } = await getReadContext({
          requireWallet: false,
        });

        const nextId = await getAmmoraV4NextConfigId(
          client,
          contracts.configRegistry,
          block
        );

        if (cancelled) return;

        const total = nextId > 1n ? nextId - 1n : 0n;
        setConfigCount((current) => current || total.toString());
        setCountStatus('ready');
      } catch {
        if (!cancelled) setCountStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function startNewConfig() {
    if (account) clearSavedConfig(account);

    setCreatedConfig(null);
    setCreatedLaunch(null);
    setPreview(null);
    setConfigStatus('idle');
    setLaunchStatus('idle');
    setNotice('You can now create a new Configuration.');
  }

  // Toasts used to stay on screen until clicked; clear them automatically.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function connectWallet() {
    const provider = window.ethereum;

    if (!provider) {
      setNotice(
        'No compatible wallet was detected. Connect using a supported wallet.'
      );
      return;
    }

    try {
      setBusy(true);
      setError('');

      const walletClient = createWalletClient({
        chain: giwaChain,
        transport: custom(provider),
      });

      const accounts = await walletClient.requestAddresses();
      const activeChain = await walletClient.getChainId();

      setAccount(accounts[0] || '');
      setChainId(activeChain);

      setNotice(
        activeChain === CHAIN_ID
          ? 'Wallet connected successfully.'
          : 'Wallet connected. Switch to GIWA Sepolia.'
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function switchNetwork() {
    const provider = window.ethereum;

    if (!provider) {
      setNotice('No compatible wallet was detected.');
      return;
    }

    try {
      setBusy(true);
      setError('');

      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CHAIN_HEX }],
        });
      } catch (err) {
        if (err.code !== 4902) throw err;

        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: CHAIN_HEX,
              chainName: deployment.chain.name,
              nativeCurrency: deployment.chain.nativeCurrency,
              rpcUrls: [deployment.chain.rpcUrls[0]],
            },
          ],
        });
      }

      const activeChain = await provider.request({
        method: 'eth_chainId',
      });

      setChainId(Number.parseInt(activeChain, 16));
      setPreview(null);
      setNotice('GIWA Sepolia selected.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Builds a verified read client at a finalized block.
   *
   * Anything that leads to a signature keeps requiring a wallet on GIWA
   * Sepolia (requireWallet = true, the default). Pure registry reads pass
   * requireWallet = false and fall back to the public RPC when there is no
   * wallet, or it is on another network.
   */
  async function getReadContext({ requireWallet = true } = {}) {
    const provider = window.ethereum;
    let source = null;

    if (!provider) {
      if (requireWallet) {
        throw new Error('No compatible wallet was detected.');
      }
    } else {
      try {
        const activeChain = Number.parseInt(
          await provider.request({ method: 'eth_chainId' }),
          16
        );

        if (activeChain === CHAIN_ID) {
          source = provider;
        } else if (requireWallet) {
          throw new Error('Switch your wallet to GIWA Sepolia first.');
        }
      } catch (err) {
        if (requireWallet) throw err;
      }
    }

    if (!source) {
      source = publicRpcProvider(deployment.chain.rpcUrls[0]);
    }

    const client = createPublicClient({
      chain: giwaChain,
      transport: pacedTransport(source),
    });

    const actualChain = await client.getChainId();

    if (actualChain !== CHAIN_ID) {
      throw new Error(`Unexpected RPC chain ID: ${actualChain}`);
    }

    const block = await resolveAmmoraFinalizedHead(
      [client],
      giwaSepoliaAutoRoute.finality
    );

    await verifyAmmoraV4CoreAtBlock(
      client,
      {
        configRegistry: contracts.configRegistry,
        launchFactory: contracts.factory,
        graduationAdapter: contracts.graduationAdapter,
        feePolicy: contracts.feePolicy,
      },
      block
    );

    return { client, block };
  }

  async function readRegistry() {
    try {
      setBusy(true);
      setReadStatus('loading');
      setError('');
      setConfigs([]);

      const { client, block } = await getReadContext({ requireWallet: false });

      const nextId = await getAmmoraV4NextConfigId(
        client,
        contracts.configRegistry,
        block
      );

      const total = nextId > 1n ? nextId - 1n : 0n;
      const count = Number(total > 5n ? 5n : total);

      setConfigCount(total.toString());
      setBlockNumber(block.toString());

      const results = [];

      for (let index = 0; index < count; index++) {
        if (index > 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const entry = await getAmmoraV4ConfigAtBlock(
          client,
          contracts.configRegistry,
          BigInt(index + 1),
          block
        );

        results.push(entry);
        setConfigs([...results]);
      }

      setReadStatus('success');
      setNotice(`Registry read complete. ${total} Configurations registered.`);
    } catch (err) {
      setReadStatus('error');
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function inspectConfig(id = selectedId) {
    try {
      const configId = BigInt(id);

      if (configId < 1n) {
        throw new Error('Configuration ID must be greater than zero.');
      }

      setBusy(true);
      setError('');
      setSelectedConfig(null);

      const { client, block } = await getReadContext({ requireWallet: false });

      const nextId = await getAmmoraV4NextConfigId(
        client,
        contracts.configRegistry,
        block
      );

      const total = nextId > 1n ? nextId - 1n : 0n;

      if (configId > total) {
        throw new Error(
          `Configuration #${configId} does not exist. Current registry count: ${total}.`
        );
      }

      const entry = await getAmmoraV4ConfigAtBlock(
        client,
        contracts.configRegistry,
        configId,
        block
      );

      setSelectedConfig(entry);
      setSelectedId(String(id));
      setConfigCount(total.toString());
      setBlockNumber(block.toString());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function prepareConfig() {
    if (!connected || !correctNetwork) {
      setNotice('Connect your wallet to GIWA Sepolia first.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      setPreview(null);
      setCreatedConfig(null);
      setCreatedLaunch(null);
      setConfigStatus('preparing');
      setLaunchStatus('idle');

      const { client, block } = await getReadContext();

      const template = await getAmmoraV4ConfigAtBlock(
        client,
        contracts.configRegistry,
        TEMPLATE_ID,
        block
      );

      if (!template.enabled) {
        throw new Error('Template Configuration #24 is disabled.');
      }

      if (
        template.config.migrationMode !== AmmoraV4MigrationMode.Concentrated
      ) {
        throw new Error('Template #24 is not a concentrated migration Configuration.');
      }

      const currentQuoteDecimals = await client.readContract({
        address: getAddress(template.config.quoteToken),
        abi: erc20DecimalsAbi,
        functionName: 'decimals',
        blockNumber: block,
      });

      const tokenDecimals = Number(template.config.tokenDecimals);
      const quoteTokenDecimals = Number(currentQuoteDecimals);

      const saleRaw = amount(saleSupply, tokenDecimals, 'Token sale supply');

      const thresholdRaw = amount(
        quoteThreshold,
        quoteTokenDecimals,
        'Graduation WETH threshold'
      );

      const plan = planGIWORAConfig(
        template,
        account,
        saleRaw,
        thresholdRaw,
        block
      );

      setQuoteDecimals(quoteTokenDecimals);

      setPreview({
        ...plan,
        tokenDecimals,
        quoteDecimals: quoteTokenDecimals,
        saleInput: saleSupply,
        thresholdInput: quoteThreshold,
      });

      setConfigStatus('preview');
    } catch (err) {
      setConfigStatus('error');
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function createConfig() {
    if (!preview) {
      setError('Prepare a Configuration preview first.');
      return;
    }

    const provider = window.ethereum;

    if (!provider) {
      setError('No compatible wallet was detected.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      setConfigStatus('creating');

      const accounts = await provider.request({
        method: 'eth_accounts',
      });

      const activeAccount = accounts?.[0] || '';

      if (
        !activeAccount ||
        activeAccount.toLowerCase() !== account.toLowerCase()
      ) {
        throw new Error(
          'Wallet account changed. Prepare a new Configuration preview.'
        );
      }

      const { client, block } = await getReadContext();

      const template = await getAmmoraV4ConfigAtBlock(
        client,
        contracts.configRegistry,
        TEMPLATE_ID,
        block
      );

      if (!template.enabled) {
        throw new Error('Template Configuration #24 is no longer enabled.');
      }

      if (
        template.configHash.toLowerCase() !== preview.templateHash.toLowerCase()
      ) {
        throw new Error(
          'Template hash changed. Prepare and review a fresh Configuration.'
        );
      }

      const saleRaw = amount(
        preview.saleInput,
        preview.tokenDecimals,
        'Token sale supply'
      );

      const thresholdRaw = amount(
        preview.thresholdInput,
        preview.quoteDecimals,
        'Graduation threshold'
      );

      const freshPlan = planGIWORAConfig(
        template,
        activeAccount,
        saleRaw,
        thresholdRaw,
        block
      );

      if (
        freshPlan.reviewHash.toLowerCase() !== preview.reviewHash.toLowerCase()
      ) {
        throw new Error(
          'Review hash changed. Please inspect the updated Configuration preview before signing.'
        );
      }

      const walletClient = createWalletClient({
        account: getAddress(activeAccount),
        chain: giwaChain,
        transport: custom(provider),
      });

      const hash = await walletClient.sendTransaction({
        account: getAddress(activeAccount),
        chain: giwaChain,
        to: contracts.configRegistry,
        data: freshPlan.transaction.data,
        value: 0n,
      });

      setConfigStatus('submitted');
      setNotice(`Configuration transaction submitted: ${hash}`);

      const receipt = await client.waitForTransactionReceipt({
        hash,
      });

      if (receipt.status !== 'success') {
        throw new Error(
          `Configuration transaction reverted. Transaction hash: ${hash}`
        );
      }

      const created = parseAmmoraV4ConfigCreatedReceipt(
        receipt,
        contracts.configRegistry
      );

      const confirmed = await getAmmoraV4ConfigAtBlock(
        client,
        contracts.configRegistry,
        created.configId,
        receipt.blockNumber
      );

      const actual = buildCreateAmmoraV4Config(
        confirmed.config,
        confirmed.segments,
        getAddress(activeAccount)
      );

      const ownerMatches =
        confirmed.identity.owner.toLowerCase() === activeAccount.toLowerCase();

      const feeClaimerMatches =
        confirmed.identity.feeClaimer.toLowerCase() ===
        activeAccount.toLowerCase();

      const recipientsMatch =
        confirmed.config.partnerRecipient.toLowerCase() ===
          activeAccount.toLowerCase() &&
        confirmed.config.leftoverReceiver.toLowerCase() ===
          activeAccount.toLowerCase() &&
        confirmed.config.liquidityDistribution.partner.toLowerCase() ===
          activeAccount.toLowerCase();

      if (
        actual.data !== freshPlan.transaction.data ||
        confirmed.configHash.toLowerCase() !==
          created.configHash.toLowerCase() ||
        !ownerMatches ||
        !feeClaimerMatches ||
        !recipientsMatch
      ) {
        throw new Error(
          `The Configuration receipt did not match all reviewed roles and calldata. Save this transaction hash: ${hash}`
        );
      }

      setCreatedConfig({
        configId: created.configId.toString(),
        configHash: created.configHash,
        owner: created.owner,
        feeClaimer: created.feeClaimer,
        blockNumber: receipt.blockNumber.toString(),
        transactionHash: hash,
        config: confirmed.config,
        segments: confirmed.segments,
      });

      saveConfig(activeAccount, {
        configId: created.configId.toString(),
        configHash: created.configHash,
        owner: created.owner,
        feeClaimer: created.feeClaimer,
        blockNumber: receipt.blockNumber.toString(),
        transactionHash: hash,
      });

      setPreview(null);
      setConfigStatus('success');
      setNotice(`GIWORA Configuration #${created.configId} created successfully.`);
    } catch (err) {
      setConfigStatus('error');
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Local preview of the chosen logo; the object URL is released on change.
  useEffect(() => {
    if (!logoFile) {
      setLogoPreview('');
      return undefined;
    }

    const url = URL.createObjectURL(logoFile);
    setLogoPreview(url);

    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  function pickLogo(file) {
    const problem = checkLogoFile(file);

    if (problem) {
      setLogoError(problem);
      return;
    }

    setLogoError('');
    setLogoFile(file);
  }

  function clearLogo() {
    setLogoFile(null);
    setLogoError('');
  }

  async function createToken() {
    if (!createdConfig) {
      setError('Create GIWORA Config first.');
      return;
    }

    const provider = window.ethereum;

    if (!provider) {
      setError('No compatible wallet was detected.');
      return;
    }

    try {
      const name = tokenName.trim();
      const symbol = tokenSymbol.trim().toUpperCase();
      let uri = metadataURI.trim();

      if (!name || name.length > 64) {
        throw new Error('Token name must contain 1–64 characters.');
      }

      if (!/^[A-Z0-9]{2,10}$/.test(symbol)) {
        throw new Error('Symbol must contain 2–10 letters or numbers.');
      }

      let links = null;

      if (metaMode === 'uri') {
        if (!/^(https:\/\/|ipfs:\/\/)\S+$/i.test(uri)) {
          throw new Error('Enter a public HTTPS or IPFS metadata JSON URI.');
        }
      } else {
        links = {
          website: normalizeLink('website', tokenWebsite),
          x: normalizeLink('x', tokenX),
          telegram: normalizeLink('telegram', tokenTelegram),
        };

        const labels = { website: 'website', x: 'X', telegram: 'Telegram' };

        for (const key of Object.keys(links)) {
          if (links[key] === null) {
            throw new Error(`The ${labels[key]} link does not look right.`);
          }
        }
      }

      setBusy(true);
      setError('');
      setLaunchStatus('preparing');
      setCreatedLaunch(null);

      const accounts = await provider.request({
        method: 'eth_accounts',
      });

      const activeAccount = accounts?.[0] || '';

      if (
        !activeAccount ||
        activeAccount.toLowerCase() !== account.toLowerCase()
      ) {
        throw new Error('Wallet account changed. Reconnect your wallet.');
      }

      const { client, block } = await getReadContext();

      const entry = await getAmmoraV4ConfigAtBlock(
        client,
        contracts.configRegistry,
        BigInt(createdConfig.configId),
        block
      );

      if (!entry.enabled) {
        throw new Error('Your GIWORA Config is no longer enabled.');
      }

      if (
        entry.configHash.toLowerCase() !==
        createdConfig.configHash.toLowerCase()
      ) {
        throw new Error('GIWORA Config hash does not match the saved receipt.');
      }

      // A remembered configuration must still belong to the connected wallet.
      if (
        String(entry.identity?.owner || '').toLowerCase() !==
        activeAccount.toLowerCase()
      ) {
        throw new Error(
          'This Configuration is not owned by the connected wallet. Start a new Configuration in Configuration Studio.'
        );
      }

      const tokenDecimals = Number(entry.config.tokenDecimals);

      // Store the logo and metadata only after every on-chain check passed.
      if (metaMode === 'form') {
        let image = '';

        if (logoFile) {
          setLaunchStep('logo');
          image = await uploadLogo(logoFile);
        }

        setLaunchStep('metadata');
        uri = await uploadMetadata({
          name,
          symbol,
          description: tokenDescription,
          image,
          ...links,
        });

        setLaunchStep('');
      }

      const transaction = buildCreateAmmoraV4Launch(
        {
          name,
          symbol,
          metadataURI: uri,
          creatorMetadataURI: uri,
          tokenDecimals,
        },
        BigInt(createdConfig.configId),
        entry.config.poolCreationFee
      );

      const walletClient = createWalletClient({
        account: getAddress(activeAccount),
        chain: giwaChain,
        transport: custom(provider),
      });

      const hash = await walletClient.sendTransaction({
        account: getAddress(activeAccount),
        chain: giwaChain,
        to: contracts.factory,
        data: transaction.data,
        value: transaction.value ?? 0n,
      });

      setLaunchStatus('submitted');
      setNotice(`Token transaction submitted: ${hash}`);

      const receipt = await client.waitForTransactionReceipt({
        hash,
      });

      if (receipt.status !== 'success') {
        throw new Error(
          `Token launch transaction reverted. Transaction hash: ${hash}`
        );
      }

      const created = parseAmmoraV4LaunchCreatedReceipt(
        receipt,
        contracts.factory
      );

      if (
        created.configId !== BigInt(createdConfig.configId) ||
        created.configHash.toLowerCase() !==
          createdConfig.configHash.toLowerCase()
      ) {
        throw new Error(
          `Token launch receipt does not match GIWORA Config. Save this transaction hash: ${hash}`
        );
      }

      setCreatedLaunch({
        token: created.token,
        curve: created.curve,
        configId: created.configId.toString(),
        configHash: created.configHash,
        protocolVersion: String(created.protocolVersion),
        transactionHash: hash,
        blockNumber: receipt.blockNumber.toString(),
        name,
        symbol,
      });

      setLaunchStatus('success');
      setNotice(`${name} (${symbol}) launched successfully.`);
    } catch (err) {
      setLaunchStatus('error');
      setError(errorMessage(err));
    } finally {
      setLaunchStep('');
      setBusy(false);
    }
  }

  const selectedConfigJSON = selectedConfig
    ? jsonStringify(selectedConfig)
    : '';

  const previewJSON = preview
    ? jsonStringify({
        config: preview.config,
        curve: preview.curve,
        economics: preview.economics,
        recipients: preview.recipients,
        reviewHash: preview.reviewHash,
      })
    : '';

  const studioStep = createdConfig ? 3 : preview ? 2 : 1;

  const networkLabel = correctNetwork
    ? 'GIWA connected'
    : connected
    ? 'Wrong network'
    : 'GIWA testnet';

  const roleRows = [
    ['Configuration owner', account],
    ['Partner recipient', account],
    ['Liquidity partner', account],
    ['Leftover receiver', account],
  ];

  return (
    <div className="site">
      <header className="header">
        <div className="header-inner">
          <button
            className="brand"
            onClick={() => setPage('Overview')}
            aria-label="GIWORA home"
          >
            <span className="brand-mark">G</span>
            <span className="brand-name">
              GIWORA<i>.</i>
            </span>
          </button>

          <nav className="nav" aria-label="Workspace">
            {NAV_ITEMS.map((item, index) => (
              <button
                key={item.id}
                className={page === item.id ? 'nav-tab active' : 'nav-tab'}
                onClick={() => setPage(item.id)}
              >
                <small>{String(index + 1).padStart(2, '0')}</small>
                {item.label}
              </button>
            ))}
          </nav>

          <div className="header-actions">
            <div className={correctNetwork ? 'chip ok' : 'chip'}>
              <span className="dot"></span>
              {networkLabel}
            </div>

            {!connected ? (
              <button
                className="btn btn-primary"
                onClick={connectWallet}
                disabled={busy}
              >
                Connect Wallet <span aria-hidden="true">↗</span>
              </button>
            ) : correctNetwork ? (
              <button
                className="btn btn-wallet"
                onClick={() => setNotice(account)}
                title={account}
              >
                <span className="dot"></span>
                {shortAddress(account)}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={switchNetwork}
                disabled={busy}
              >
                Switch network <span aria-hidden="true">↗</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="main">
        {error && (
          <div className="alert" role="alert">
            <div className="alert-icon">!</div>
            <div className="alert-copy">
              <strong>Something needs attention</strong>
              <span>{error}</span>
            </div>
            <button className="link-btn" onClick={() => setError('')}>
              Dismiss
            </button>
          </div>
        )}

        {page === 'Overview' && (
          <>
            <section className="hero">
              <div className="sky" aria-hidden="true"></div>

              <div className="hero-copy">
                <div className="eyebrow">
                  <span className="eyebrow-line"></span>
                  Token launch platform
                </div>

                <h1>
                  Make your next
                  <br />
                  <em>launch happen.</em>
                </h1>

                <p className="lead">
                  A focused launchpad for the GIWA ecosystem. Create your own
                  launch configuration and issue tokens using Ammora
                  infrastructure.
                </p>

                <div className="btn-row">
                  <button
                    className="btn btn-primary btn-lg"
                    onClick={() => setPage('Config Studio')}
                  >
                    Build GIWORA Configuration <span aria-hidden="true">↗</span>
                  </button>

                  <button
                    className="btn btn-ghost btn-lg"
                    onClick={() => setPage('Registry')}
                  >
                    Explore Registry
                  </button>
                </div>

                <div className="hero-foot">
                  <span>Built on GIWA</span>
                  <i></i>
                  <span>Powered by Ammora SDK</span>
                </div>
              </div>

              <div className="hero-visual">
                <div className="orbit-stage" aria-hidden="true">
                  <OrbitEmblem className="orbit-backdrop" core={false} />
                </div>

                <div className="visual-card">
                  <div className="visual-top">
                    <span className="visual-title">
                      <OrbitEmblem className="orbit-mini" />
                      <span className="mono-label">Launch curve</span>
                    </span>
                    <span className="chip ok">
                      <span className="dot"></span>
                      Testnet
                    </span>
                  </div>

                  <BondingCurve />

                  <div className="visual-meta">
                    <div>
                      <span>Template</span>
                      <strong>#24</strong>
                    </div>
                    <div>
                      <span>Chain ID</span>
                      <strong>91342</strong>
                    </div>
                    <div>
                      <span>Graduation</span>
                      <strong>Concentrated</strong>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="stats">
              <div className="stat">
                <div className="stat-label">Registry configurations</div>
                {configCount ? (
                  <>
                    <div className="stat-value">{configCount}</div>
                    <div className="stat-caption">
                      Registered on GIWA Sepolia
                    </div>
                  </>
                ) : countStatus === 'loading' ? (
                  <>
                    <div className="stat-value sm">Loading…</div>
                    <div className="stat-caption">Reading GIWA Sepolia</div>
                  </>
                ) : (
                  <>
                    <div className="stat-value sm">Not loaded</div>
                    <div className="stat-caption">
                      <button
                        className="link-btn"
                        onClick={() => setPage('Registry')}
                      >
                        Open Registry to load{' '}
                        <span aria-hidden="true">↗</span>
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="stat">
                <div className="stat-label">Wallet</div>
                <div className="stat-value sm">
                  {connected ? 'Connected' : 'Not connected'}
                </div>
                <div className="stat-caption">
                  {connected
                    ? shortAddress(account)
                    : 'Connect your wallet to continue'}
                </div>
              </div>

              <div className="stat">
                <div className="stat-label">SDK deployment</div>
                <div className="stat-value sm">
                  {sdkReady ? 'V4 · GIWA' : 'Unavailable'}
                </div>
                <div className="stat-caption">Auto-Route deployment catalog</div>
              </div>
            </section>

            <section className="section">
              <div className="section-head">
                <div>
                  <div className="mono-label accent">Get started</div>
                  <h2>Build Your Own Launch Configuration</h2>
                  <p>
                    GIWORA uses a reviewed Ammora template and assigns all team
                    roles to your connected wallet.
                  </p>
                </div>

                <button
                  className="btn btn-primary"
                  onClick={() => setPage('Config Studio')}
                >
                  Open Configuration Studio <span aria-hidden="true">↗</span>
                </button>
              </div>

              <div className="steps">
                <button className="step" onClick={() => setPage('Config Studio')}>
                  <span className="step-num">01</span>
                  <strong>Configure</strong>
                  <p>
                    Set your sale allocation and graduation target on top of
                    Template #24.
                  </p>
                </button>

                <button className="step" onClick={() => setPage('Config Studio')}>
                  <span className="step-num">02</span>
                  <strong>Review</strong>
                  <p>
                    Inspect the calculated curve, economics and review hash
                    before you sign anything.
                  </p>
                </button>

                <button className="step" onClick={() => setPage('Token Launch')}>
                  <span className="step-num">03</span>
                  <strong>Launch</strong>
                  <p>
                    Create your token and its Ammora launch curve from your
                    confirmed configuration.
                  </p>
                </button>
              </div>
            </section>

            <section className="tools">
              <span className="mono-label">GIWA testnet tools</span>
              <div className="tools-links">
                <a
                  href="https://faucet.giwa.io/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GIWA Faucet <span aria-hidden="true">↗</span>
                </a>
                <a
                  href="https://sepolia-bridge.giwa.io/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GIWA Bridge <span aria-hidden="true">↗</span>
                </a>
              </div>
            </section>
          </>
        )}

        {page === 'Registry' && (
          <section className="page">
            <div className="page-head">
              <div>
                <div className="mono-label accent">On-chain data</div>
                <h2>Launch Configurations</h2>
                <p>Read the GIWA V4 registry directly from the blockchain.</p>
              </div>

              <button
                className="btn btn-primary"
                onClick={readRegistry}
                disabled={busy}
              >
                {busy ? 'Reading...' : 'Read Registry'}{' '}
                <span aria-hidden="true">↻</span>
              </button>
            </div>

            <div
              className={
                readStatus === 'error'
                  ? 'status-panel is-error'
                  : readStatus === 'success'
                  ? 'status-panel is-ok'
                  : 'status-panel'
              }
            >
              <div className="status-icon">
                {readStatus === 'success'
                  ? '✓'
                  : readStatus === 'error'
                  ? '!'
                  : '◈'}
              </div>
              <div className="status-copy">
                <strong>
                  {readStatus === 'idle' && 'Ready to inspect registry'}
                  {readStatus === 'loading' && 'Reading GIWA Sepolia...'}
                  {readStatus === 'reading' &&
                    'Reading configuration entries...'}
                  {readStatus === 'success' && 'On-chain registry read complete'}
                  {readStatus === 'error' && 'Registry read failed'}
                </strong>
                <span>
                  Read-only operation. No wallet, signature or funds are
                  required.
                </span>
                {readStatus === 'success' && (
                  <small>
                    Block {blockNumber} · showing up to 5 of {configCount}{' '}
                    configurations
                  </small>
                )}
              </div>
            </div>

            <div className="cfg-list">
              {configs.map((entry) => (
                <article className="cfg-card" key={String(entry.configId)}>
                  <div className="cfg-id">
                    <span>Config</span>
                    <strong>#{String(entry.configId)}</strong>
                  </div>

                  <div className="cfg-body">
                    <div className="cfg-title">
                      <h3>Launch Configuration #{String(entry.configId)}</h3>
                      <span
                        className={entry.enabled ? 'badge ok' : 'badge bad'}
                      >
                        <i></i>
                        {entry.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>

                    <div className="cfg-facts">
                      <span>
                        Owner <b>{shortAddress(entry.identity?.owner)}</b>
                      </span>
                      <span>
                        Quote token{' '}
                        <b>{shortAddress(entry.config?.quoteToken)}</b>
                      </span>
                      <span>
                        Migration mode{' '}
                        <b>{String(entry.config?.migrationMode ?? '—')}</b>
                      </span>
                      <span>
                        Segments <b>{entry.segments?.length ?? 0}</b>
                      </span>
                    </div>

                    <button
                      className="link-btn"
                      onClick={() => inspectConfig(String(entry.configId))}
                      disabled={busy}
                    >
                      Inspect full configuration <span aria-hidden="true">↗</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <div className="panel inspector">
              <div className="mono-label accent">Configuration inspector</div>
              <h3 className="panel-title">Inspect by ID</h3>
              <p className="panel-sub">
                Read the complete configuration and immutable hash.
              </p>

              <div className="inspect-row">
                <input
                  className="input"
                  type="number"
                  min="1"
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                  placeholder="Configuration ID"
                />
                <button
                  className="btn btn-primary"
                  onClick={() => inspectConfig()}
                  disabled={busy}
                >
                  {busy ? 'Inspecting...' : 'Inspect configuration'}{' '}
                  <span aria-hidden="true">↗</span>
                </button>
              </div>

              {selectedConfig && (
                <div className="result">
                  <div className="result-head">
                    <div>
                      <div className="mono-label accent">
                        Inspected configuration
                      </div>
                      <h3>Configuration #{String(selectedConfig.configId)}</h3>
                    </div>
                    <span
                      className={selectedConfig.enabled ? 'badge ok' : 'badge bad'}
                    >
                      <i></i>
                      {selectedConfig.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>

                  <div className="facts">
                    <div>
                      <span>Owner</span>
                      <strong>
                        {shortAddress(selectedConfig.identity?.owner)}
                      </strong>
                    </div>
                    <div>
                      <span>Fee recipient</span>
                      <strong>
                        {shortAddress(selectedConfig.identity?.feeClaimer)}
                      </strong>
                    </div>
                    <div>
                      <span>Quote token</span>
                      <strong>
                        {shortAddress(selectedConfig.config?.quoteToken)}
                      </strong>
                    </div>
                    <div>
                      <span>Token decimals</span>
                      <strong>
                        {String(selectedConfig.config?.tokenDecimals)}
                      </strong>
                    </div>
                    <div>
                      <span>Migration mode</span>
                      <strong>
                        {String(selectedConfig.config?.migrationMode)}
                      </strong>
                    </div>
                    <div>
                      <span>Curve segments</span>
                      <strong>{selectedConfig.segments?.length ?? 0}</strong>
                    </div>
                  </div>

                  <div className="hash-box">
                    <span>Configuration hash</span>
                    <code>{selectedConfig.configHash}</code>
                  </div>

                  <pre className="json-view">{selectedConfigJSON}</pre>
                </div>
              )}
            </div>
          </section>
        )}

        {page === 'Config Studio' && (
          <section className="page">
            <div className="page-head">
              <div>
                <div className="mono-label accent">
                  GIWORA / Configuration Studio
                </div>
                <h2>Create Your Own Launch Configuration</h2>
                <p>
                  Template #24 · GIWA Sepolia · Concentrated graduation. Every
                  team recipient is set to your connected wallet.
                </p>
              </div>
            </div>

            <ol className="progress" aria-label="Configuration progress">
              <li className={studioStep >= 1 ? 'on' : ''}>
                <b>1</b> Set economics
              </li>
              <li className={studioStep >= 2 ? 'on' : ''}>
                <b>2</b> Review preview
              </li>
              <li className={studioStep >= 3 ? 'on' : ''}>
                <b>3</b> Confirmed on-chain
              </li>
            </ol>

            <div className="studio">
              <div className="studio-main">
                <div className="panel">
                  <div className="mono-label accent">Launch economics</div>
                  <h3 className="panel-title">Template #24</h3>

                  <div className="form">
                    <label className="field">
                      <span className="field-label">Token sale allocation</span>
                      <input
                        className="input"
                        value={saleSupply}
                        onChange={(event) => {
                          setSaleSupply(event.target.value);
                          setPreview(null);
                          setConfigStatus('idle');
                        }}
                        inputMode="decimal"
                        placeholder="1000000"
                        disabled={busy || Boolean(createdConfig)}
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">
                        Graduation quote threshold (WETH)
                      </span>
                      <input
                        className="input"
                        value={quoteThreshold}
                        onChange={(event) => {
                          setQuoteThreshold(event.target.value);
                          setPreview(null);
                          setConfigStatus('idle');
                        }}
                        inputMode="decimal"
                        placeholder="0.001"
                        disabled={busy || Boolean(createdConfig)}
                      />
                    </label>
                  </div>

                  <div className="note">
                    <strong>Inherited policy</strong>
                    <span>
                      Template fee rates, LP ratios, vesting and graduation mode
                      are inherited. The SDK recalculates curve reserves,
                      migration base threshold, post-migration liquidity and
                      total supply for the selected sale and WETH target.
                    </span>
                  </div>

                  <button
                    className="btn btn-primary btn-block-sm"
                    onClick={prepareConfig}
                    disabled={
                      busy ||
                      !connected ||
                      !correctNetwork ||
                      Boolean(createdConfig)
                    }
                  >
                    {busy && configStatus === 'preparing'
                      ? 'Calculating configuration...'
                      : 'Prepare configuration preview'}{' '}
                    <span aria-hidden="true">↗</span>
                  </button>
                </div>

                {preview && (
                  <div className="panel">
                    <div className="result-head">
                      <div>
                        <div className="mono-label accent">
                          Unsigned configuration preview
                        </div>
                        <h3>Ready for review</h3>
                      </div>
                      <span className="badge ok">
                        <i></i> Validated
                      </span>
                    </div>

                    <div className="facts">
                      <div>
                        <span>Template</span>
                        <strong>#{preview.templateId}</strong>
                      </div>
                      <div>
                        <span>Snapshot block</span>
                        <strong>{preview.blockNumber}</strong>
                      </div>
                      <div>
                        <span>Token decimals</span>
                        <strong>{preview.tokenDecimals}</strong>
                      </div>
                      <div>
                        <span>WETH decimals</span>
                        <strong>{preview.quoteDecimals}</strong>
                      </div>
                      <div>
                        <span>Sale allocation</span>
                        <strong>{preview.saleInput}</strong>
                      </div>
                      <div>
                        <span>Graduation target</span>
                        <strong>{preview.thresholdInput} WETH</strong>
                      </div>
                    </div>

                    <div className="hash-box">
                      <span>Review hash · required before signing</span>
                      <code>{preview.reviewHash}</code>
                    </div>

                    <div className="note">
                      <strong>Recipient verification</strong>
                      <span>
                        Configuration Owner, Partner Recipient, Liquidity Partner
                        and Leftover Receiver are all set to{' '}
                        {shortAddress(account)}.
                      </span>
                    </div>

                    <div className="json-head">
                      <strong>Calculated configuration and economics</strong>
                      <button
                        className="link-btn"
                        onClick={() =>
                          navigator.clipboard
                            ?.writeText(previewJSON)
                            .then(() => setNotice('Preview JSON copied.'))
                            .catch(() => setNotice('Clipboard unavailable.'))
                        }
                      >
                        Copy preview JSON <span aria-hidden="true">↗</span>
                      </button>
                    </div>

                    <pre className="json-view">{previewJSON}</pre>

                    <button
                      className="btn btn-primary btn-block-sm"
                      onClick={createConfig}
                      disabled={busy || !connected || !correctNetwork}
                    >
                      {busy && configStatus === 'creating'
                        ? 'Waiting for wallet confirmation...'
                        : 'Create GIWORA Configuration'}{' '}
                      <span aria-hidden="true">↗</span>
                    </button>

                    <p className="fineprint">
                      This sends a transaction to the GIWA Sepolia Configuration
                      Registry. Review the exact network, target and gas in your
                      wallet before approving. The transaction creates a new
                      immutable Configuration; it does not create a token.
                    </p>
                  </div>
                )}

                {createdConfig && (
                  <div className="panel is-success">
                    <div className="result-head">
                      <div>
                        <div className="mono-label accent">On-chain success</div>
                        <h3>GIWORA Configuration #{createdConfig.configId}</h3>
                      </div>
                      <span className="badge ok">
                        <i></i> Confirmed
                      </span>
                    </div>

                    <div className="facts">
                      <div>
                        <span>Configuration ID</span>
                        <strong>#{createdConfig.configId}</strong>
                      </div>
                      <div>
                        <span>Owner</span>
                        <strong>{shortAddress(createdConfig.owner)}</strong>
                      </div>
                      <div>
                        <span>Fee recipient</span>
                        <strong>{shortAddress(createdConfig.feeClaimer)}</strong>
                      </div>
                      <div>
                        <span>Block</span>
                        <strong>{createdConfig.blockNumber}</strong>
                      </div>
                    </div>

                    <div className="hash-box">
                      <span>Confirmed configuration hash</span>
                      <code>{createdConfig.configHash}</code>
                    </div>

                    <div className="hash-box">
                      <span>Transaction hash</span>
                      <code>{createdConfig.transactionHash}</code>
                    </div>

                    <div className="btn-row">
                      <button
                        className="btn btn-primary btn-block-sm"
                        onClick={() => setPage('Token Launch')}
                      >
                        Continue to Token Launch{' '}
                        <span aria-hidden="true">↗</span>
                      </button>

                      <button
                        className="btn btn-ghost btn-block-sm"
                        onClick={startNewConfig}
                        disabled={busy}
                      >
                        Start a new Configuration
                      </button>
                    </div>

                    <p className="fineprint">
                      This Configuration is remembered in this browser for your
                      wallet, so you can come back and launch a token later.
                    </p>
                  </div>
                )}

                {configStatus === 'error' && (
                  <div className="note is-error">
                    <strong>Configuration creation failed</strong>
                    <span>{error}</span>
                  </div>
                )}
              </div>

              <aside className="studio-side">
                <div className="panel panel-compact">
                  <div className="mono-label accent">Team wallet</div>
                  <h3 className="panel-title">
                    {connected ? shortAddress(account) : 'Connect your wallet first'}
                  </h3>

                  <dl className="roles">
                    {roleRows.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{connected ? shortAddress(value) : '—'}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </aside>
            </div>
          </section>
        )}

        {page === 'Token Launch' && (
          <section className="page">
            <div className="page-head">
              <div>
                <div className="mono-label accent">GIWORA / Token Launch</div>
                <h2>Launch a Token with Your Configuration</h2>
                <p>
                  Create a token and its Ammora launch curve using your own
                  GIWORA configuration after it has been confirmed.
                </p>
              </div>
            </div>

            {!createdConfig && (
              <div className="status-panel">
                <div className="status-icon">!</div>
                <div className="status-copy">
                  <strong>No GIWORA configuration has been created yet.</strong>
                  <span>
                    Create and confirm your own GIWORA Configuration in
                    Configuration Studio first. Token launches can only use
                    configurations you created and confirmed.
                  </span>
                  <button
                    className="link-btn"
                    onClick={() => setPage('Config Studio')}
                  >
                    Go to Configuration Studio <span aria-hidden="true">↗</span>
                  </button>
                </div>
              </div>
            )}

            <div className="panel">
              <div className="mono-label accent">
                {createdConfig
                  ? 'Confirmed GIWORA configuration'
                  : 'Token details'}
              </div>
              <h3 className="panel-title">
                {createdConfig
                  ? `Configuration #${createdConfig.configId}`
                  : 'Available after you create a configuration'}
              </h3>
              {createdConfig && (
                <p className="hash-line">{createdConfig.configHash}</p>
              )}

                <div className="launch-grid">
                  <div className="launch-form">
                    <div className="field-row">
                      <label className="field">
                        <span className="field-label">Token name</span>
                        <input
                          className="input"
                          value={tokenName}
                          onChange={(event) => setTokenName(event.target.value)}
                          placeholder="e.g. Moon Cat"
                          maxLength={64}
                          autoComplete="off"
                          disabled={busy || !createdConfig}
                        />
                      </label>

                      <label className="field field-sm">
                        <span className="field-label">Symbol</span>
                        <input
                          className="input"
                          value={tokenSymbol}
                          onChange={(event) =>
                            setTokenSymbol(
                              event.target.value
                                .toUpperCase()
                                .replace(/[^A-Z0-9]/g, '')
                            )
                          }
                          placeholder="MCAT"
                          maxLength={10}
                          autoComplete="off"
                          disabled={busy || !createdConfig}
                        />
                      </label>
                    </div>

                    <div className="seg" role="group" aria-label="Metadata source">
                      <button
                        type="button"
                        className={metaMode === 'form' ? 'seg-btn on' : 'seg-btn'}
                        onClick={() => setMetaMode('form')}
                        disabled={busy}
                      >
                        Create it for me
                      </button>
                      <button
                        type="button"
                        className={metaMode === 'uri' ? 'seg-btn on' : 'seg-btn'}
                        onClick={() => setMetaMode('uri')}
                        disabled={busy}
                      >
                        I have a metadata link
                      </button>
                    </div>

                    {metaMode === 'form' ? (
                      <>
                        <div className="field">
                          <span className="field-label">
                            Logo <em>optional</em>
                          </span>

                          <label
                            className={
                              'dropzone' +
                              (logoDragging ? ' is-drag' : '') +
                              (logoFile ? ' has-file' : '')
                            }
                            onDragOver={(event) => {
                              event.preventDefault();
                              setLogoDragging(true);
                            }}
                            onDragLeave={() => setLogoDragging(false)}
                            onDrop={(event) => {
                              event.preventDefault();
                              setLogoDragging(false);
                              if (busy || !createdConfig) return;
                              pickLogo(event.dataTransfer.files?.[0]);
                            }}
                          >
                            <input
                              className="visually-hidden"
                              type="file"
                              accept="image/png,image/jpeg,image/webp,image/gif"
                              onChange={(event) => {
                                pickLogo(event.target.files?.[0]);
                                event.target.value = '';
                              }}
                              disabled={busy || !createdConfig}
                            />

                            {logoPreview ? (
                              <img
                                className="dz-thumb"
                                src={logoPreview}
                                alt="Selected logo"
                              />
                            ) : (
                              <span className="dz-icon" aria-hidden="true">
                                ↑
                              </span>
                            )}

                            <span className="dz-copy">
                              <strong>
                                {logoFile
                                  ? logoFile.name
                                  : 'Drop an image here or click to browse'}
                              </strong>
                              <small>
                                {logoFile
                                  ? formatBytes(logoFile.size)
                                  : 'PNG, JPG, WEBP or GIF · up to 2 MB · square works best'}
                              </small>
                            </span>

                            {logoFile && (
                              <button
                                type="button"
                                className="link-btn dz-remove"
                                onClick={(event) => {
                                  event.preventDefault();
                                  clearLogo();
                                }}
                                disabled={busy}
                              >
                                Remove
                              </button>
                            )}
                          </label>

                          {logoError && (
                            <span className="field-error" role="alert">
                              {logoError}
                            </span>
                          )}
                        </div>

                        <label className="field">
                          <span className="field-label">
                            Description <em>optional</em>
                          </span>
                          <textarea
                            className="input textarea"
                            value={tokenDescription}
                            onChange={(event) =>
                              setTokenDescription(event.target.value)
                            }
                            placeholder="What is this token about?"
                            maxLength={500}
                            rows={3}
                            disabled={busy || !createdConfig}
                          />
                          <span className="field-count">
                            {tokenDescription.length}/500
                          </span>
                        </label>

                        <div className="field-row three">
                          <label className="field">
                            <span className="field-label">
                              Website <em>optional</em>
                            </span>
                            <input
                              className="input"
                              value={tokenWebsite}
                              onChange={(event) =>
                                setTokenWebsite(event.target.value)
                              }
                              placeholder="example.com"
                              autoComplete="off"
                              disabled={busy || !createdConfig}
                            />
                          </label>

                          <label className="field">
                            <span className="field-label">
                              X <em>optional</em>
                            </span>
                            <input
                              className="input"
                              value={tokenX}
                              onChange={(event) => setTokenX(event.target.value)}
                              placeholder="@yourname"
                              autoComplete="off"
                              disabled={busy || !createdConfig}
                            />
                          </label>

                          <label className="field">
                            <span className="field-label">
                              Telegram <em>optional</em>
                            </span>
                            <input
                              className="input"
                              value={tokenTelegram}
                              onChange={(event) =>
                                setTokenTelegram(event.target.value)
                              }
                              placeholder="@yourgroup"
                              autoComplete="off"
                              disabled={busy || !createdConfig}
                            />
                          </label>
                        </div>

                        <div className="note">
                          <strong>Everything here becomes public</strong>
                          <span>
                            Your logo and details are saved to public storage so
                            wallets and explorers can show them. The link to them
                            is written into the launch transaction.
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <label className="field">
                          <span className="field-label">
                            Public metadata JSON URI
                          </span>
                          <input
                            className="input"
                            value={metadataURI}
                            onChange={(event) => setMetadataURI(event.target.value)}
                            placeholder="https://.../metadata.json or ipfs://..."
                            autoComplete="off"
                            disabled={busy || !createdConfig}
                          />
                        </label>

                        <div className="note">
                          <strong>Metadata requirement</strong>
                          <span>
                            The link must point to a public JSON metadata
                            document. Do not use example.com or a placeholder
                            address. Upload and verify your actual metadata
                            before launching.
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {metaMode === 'form' && (
                    <aside className="token-card" aria-label="Token preview">
                      <span className="mono-label">Preview</span>

                      <div className="token-card-logo">
                        {logoPreview ? (
                          <img src={logoPreview} alt="" />
                        ) : (
                          <b>
                            {(tokenSymbol || tokenName || 'G')
                              .trim()
                              .charAt(0)
                              .toUpperCase()}
                          </b>
                        )}
                      </div>

                      <strong className="token-card-name">
                        {tokenName.trim() || 'Token name'}
                      </strong>
                      <span className="token-card-symbol">
                        {tokenSymbol || 'SYMBOL'}
                      </span>

                      <p className={tokenDescription.trim() ? '' : 'is-empty'}>
                        {tokenDescription.trim() ||
                          'Your description will show up here.'}
                      </p>

                      <div className="token-card-links">
                        {tokenWebsite.trim() && <span>Website</span>}
                        {tokenX.trim() && <span>X</span>}
                        {tokenTelegram.trim() && <span>Telegram</span>}
                      </div>
                    </aside>
                  )}
                </div>

                
<button
                  className="btn btn-primary btn-block-sm"
                  onClick={createToken}
                  disabled={
                    busy ||
                    !createdConfig ||
                    !correctNetwork ||
                    !tokenName.trim() ||
                    !tokenSymbol.trim() ||
                    (metaMode === 'uri' && !metadataURI.trim())
                  }
                >
                  {launchStep === 'logo'
                    ? 'Uploading Logo...'
                    : launchStep === 'metadata'
                    ? 'Saving Details...'
                    : busy && launchStatus === 'preparing'
                    ? 'Preparing Token...'
                    : 'Create Token'}{' '}
                  <span aria-hidden="true">↗</span>
                </button>

                {createdLaunch && (
                  <div className="note is-success">
                    <strong>Token creation confirmed</strong>
                    <span>
                      Token: {createdLaunch.name} ({createdLaunch.symbol})
                      <br />
                      Token address: {createdLaunch.token}
                      <br />
                      Curve address: {createdLaunch.curve}
                      <br />
                      Config: #{createdLaunch.configId}
                      <br />
                      Block: {createdLaunch.blockNumber}
                      <br />
                      Transaction: {createdLaunch.transactionHash}
                    </span>
                  </div>
                )}
            </div>
          </section>
        )}

        <section className="cta">
          <div className="sky in-card" aria-hidden="true"></div>

          <div className="cta-copy">
            <div className="mono-label accent">GIWORA launchpad</div>
            <h2>Build the next project on GIWA.</h2>
            <p>Independent project. Built with Ammora SDK.</p>
          </div>

          <OrbitEmblem className="orbit-lg" />
        </section>
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <span>© 2026 GIWORA</span>
          <span>Independent Web3 launchpad</span>
          <span>GIWA Sepolia · Ammora SDK</span>
        </div>
        <p className="footer-note">
          GIWORA is an independent community-built project and is not an official
          Ammora product. Deployed on a test network for testing and
          experimentation.
        </p>
      </footer>

      {notice && (
        <div className="toast" onClick={() => setNotice('')}>
          <span>{notice}</span>
          <button onClick={() => setNotice('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
