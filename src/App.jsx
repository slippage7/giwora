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

const deployment = giwaSepoliaAutoRouteDeployment;
const contracts = deployment.contracts.launch;

const CHAIN_ID = 91342;
const CHAIN_HEX = '0x164ce';
const TEMPLATE_ID = 24n;

const DEFAULT_WALLET = '0x4C855204c4EeD411a03D20acE673d08837A8F5ee';

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

  const [selectedId, setSelectedId] = useState('24');
  const [selectedConfig, setSelectedConfig] = useState(null);

  const [saleSupply, setSaleSupply] = useState('1000000');
  const [quoteThreshold, setQuoteThreshold] = useState('0.001');
  const [quoteDecimals, setQuoteDecimals] = useState(null);

  const [preview, setPreview] = useState(null);
  const [configStatus, setConfigStatus] = useState('idle');
  const [createdConfig, setCreatedConfig] = useState(null);

  const [tokenName, setTokenName] = useState('GIWORA Test');
  const [tokenSymbol, setTokenSymbol] = useState('GWRT');
  const [metadataURI, setMetadataURI] = useState('');

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

  async function getReadContext() {
    const provider = window.ethereum;

    if (!provider) {
      throw new Error('No compatible wallet was detected.');
    }

    const activeChain = Number.parseInt(
      await provider.request({ method: 'eth_chainId' }),
      16
    );

    if (activeChain !== CHAIN_ID) {
      throw new Error('Switch your wallet to GIWA Sepolia first.');
    }

    const client = createPublicClient({
      chain: giwaChain,
      transport: pacedTransport(provider),
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
    if (!connected || !correctNetwork) {
      setNotice('Connect your wallet to GIWA Sepolia first.');
      return;
    }

    try {
      setBusy(true);
      setReadStatus('loading');
      setError('');
      setConfigs([]);

      const { client, block } = await getReadContext();

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
    if (!connected || !correctNetwork) {
      setNotice('Connect your wallet to GIWA Sepolia first.');
      return;
    }

    try {
      const configId = BigInt(id);

      if (configId < 1n) {
        throw new Error('Configuration ID must be greater than zero.');
      }

      setBusy(true);
      setError('');
      setSelectedConfig(null);

      const { client, block } = await getReadContext();

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
      const uri = metadataURI.trim();

      if (!name || name.length > 64) {
        throw new Error('Token name must contain 1–64 characters.');
      }

      if (!/^[A-Z0-9]{2,10}$/.test(symbol)) {
        throw new Error('Symbol must contain 2–10 letters or numbers.');
      }

      if (!/^(https:\/\/|ipfs:\/\/)\S+$/i.test(uri)) {
        throw new Error('Enter a public HTTPS or IPFS metadata JSON URI.');
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

      const tokenDecimals = Number(entry.config.tokenDecimals);

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">G</div>
          <div>
            <div className="brand-name">
              GIWORA<span>.</span>
            </div>
            <div className="brand-subtitle">TOKEN LAUNCHPAD</div>
          </div>
        </div>

        <div className="sidebar-section-label">WORKSPACE</div>

        <nav className="sidebar-nav">
          <button
            className={page === 'Overview' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('Overview')}
          >
            <span className="nav-symbol">◫</span>
            Overview
          </button>

          <button
            className={page === 'Registry' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('Registry')}
          >
            <span className="nav-symbol">◈</span>
            Configuration Registry
          </button>

          <button
            className={
              page === 'Config Studio' ? 'nav-item active' : 'nav-item'
            }
            onClick={() => setPage('Config Studio')}
          >
            <span className="nav-symbol">＋</span>
            Configuration Studio
          </button>

          <button
            className={page === 'Token Launch' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('Token Launch')}
          >
            <span className="nav-symbol">◇</span>
            Token Launch
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="network-card">
            <div className="network-card-top">
              <span className="status-dot"></span>
              TEST NETWORK
            </div>
            <strong>GIWA Sepolia</strong>
            <span className="network-id">Chain ID · 91342</span>
          </div>

          <div className="sidebar-footer">INDEPENDENT WEB3 PROJECT</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <div className="topbar-kicker">GIWORA WORKSPACE</div>
            <div className="breadcrumb">{page}</div>
          </div>

          <div className="topbar-actions">
            <div className="network-indicator">
              <span
                className={correctNetwork ? 'status-dot' : 'status-dot muted'}
              ></span>
              {correctNetwork
                ? 'GIWA CONNECTED'
                : connected
                ? 'WRONG NETWORK'
                : 'GIWA TESTNET'}
            </div>

            {!connected ? (
              <button
                className="wallet-button"
                onClick={connectWallet}
                disabled={busy}
              >
                Connect Wallet ↗
              </button>
            ) : correctNetwork ? (
              <button
                className="wallet-button connected"
                onClick={() => setNotice(account)}
                title={account}
              >
                <span className="status-dot"></span>
                {shortAddress(account)}
              </button>
            ) : (
              <button
                className="wallet-button"
                onClick={switchNetwork}
                disabled={busy}
              >
                Switch network ↗
              </button>
            )}
          </div>
        </header>

        <div className="content">
          {error && (
            <div className="read-status-panel" style={{ marginBottom: 16 }}>
              <div className="read-status-icon">!</div>
              <div className="read-status-copy">
                <strong>Something needs attention</strong>
                <span className="error-text">{error}</span>
                <button className="text-button" onClick={() => setError('')}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {page === 'Overview' && (
            <>
              <section className="hero">
                <div className="hero-copy">
                  <div className="eyebrow">
                    <span></span>
                    INDEPENDENT TOKEN LAUNCHPAD
                  </div>

                  <h1>
                    Make your next
                    <br />
                    <em>launch happen.</em>
                  </h1>

                  <p>
                    A focused launchpad for the GIWA ecosystem. Create your own
                    launch configuration and issue tokens using Ammora
                    infrastructure.
                  </p>

                  <div className="hero-buttons">
                    <button
                      className="primary-button"
                      onClick={() => setPage('Config Studio')}
                    >
                      Build GIWORA Configuration <span>↗</span>
                    </button>

                    <button
                      className="outline-button"
                      onClick={() => setPage('Registry')}
                    >
                      Explore Registry
                    </button>
                  </div>

                  <div className="hero-footnote">
                    <span>BUILT ON GIWA</span>
                    <i></i>
                    <span>POWERED BY AMMORA SDK</span>
                  </div>
                </div>

                <div className="hero-visual" aria-hidden="true">
                  <div className="visual-ring ring-a"></div>
                  <div className="visual-ring ring-b"></div>
                  <div className="visual-ring ring-c"></div>
                  <div className="visual-glow"></div>
                  <div className="visual-core">
                    <span>G</span>
                  </div>
                  <div className="visual-orbit-dot dot-a"></div>
                  <div className="visual-orbit-dot dot-b"></div>
                  <div className="visual-cross cross-a">✳</div>
                  <div className="visual-cross cross-b">✦</div>
                </div>
              </section>

              <section className="stats-grid">
                <div className="stat-card">
                  <div className="stat-label">
                    REGISTRY CONFIGURATIONS <span>◈</span>
                  </div>
                  <div className="stat-value">{configCount || '—'}</div>
                  <div className="stat-caption">Registered on GIWA Sepolia</div>
                </div>

                <div className="stat-card">
                  <div className="stat-label">
                    WALLET <span>⌁</span>
                  </div>
                  <div className="stat-value stat-value-small">
                    {connected ? 'Connected' : 'Not Connected'}
                  </div>
                  <div className="stat-caption">
                    {connected
                      ? shortAddress(account)
                      : 'Connect your wallet to continue'}
                  </div>
                </div>

                <div className="stat-card">
                  <div className="stat-label">
                    SDK DEPLOYMENT <span>◇</span>
                  </div>
                  <div className="stat-value stat-value-small">
                    {sdkReady ? 'V4 · GIWA' : 'Unavailable'}
                  </div>
                  <div className="stat-caption">
                    Auto-Route deployment catalog
                  </div>
                </div>
              </section>

              <section className="registry-section">
                <div className="section-heading">
                  <div>
                    <div className="section-kicker">GET STARTED</div>
                    <h2>Build Your Own Launch Configuration</h2>
                    <p>
                      GIWORA uses a reviewed Ammora template and assigns all
                      team roles to your connected wallet.
                    </p>
                  </div>

                  <button
                    className="primary-button"
                    onClick={() => setPage('Config Studio')}
                  >
                    Open Configuration Studio ↗
                  </button>
                </div>
              </section>
            </>
          )}

          {page === 'Registry' && (
            <section className="registry-section" style={{ marginTop: 0 }}>
              <div className="section-heading">
                <div>
                  <div className="section-kicker">ON-CHAIN DATA</div>
                  <h2>Launch Configurations</h2>
                  <p>Read the GIWA V4 registry directly from the blockchain.</p>
                </div>

                <button
                  className="primary-button"
                  onClick={readRegistry}
                  disabled={busy || !connected || !correctNetwork}
                >
                  {busy ? 'Reading...' : 'Read Registry ↻'}
                </button>
              </div>

              <div className="read-status-panel">
                <div className="read-status-icon">
                  {readStatus === 'success'
                    ? '✓'
                    : readStatus === 'error'
                    ? '!'
                    : '◈'}
                </div>
                <div className="read-status-copy">
                  <strong>
                    {readStatus === 'idle' && 'Ready to Inspect Registry'}
                    {readStatus === 'loading' && 'Reading GIWA Sepolia...'}
                    {readStatus === 'reading' && 'Reading Configuration Entries...'}
                    {readStatus === 'success' &&
                      'On-chain registry read complete'}
                    {readStatus === 'error' && 'Registry read failed'}
                  </strong>
                  <span>
                    Read-only operation. No wallet signature or funds are required.
                  </span>
                  {readStatus === 'success' && (
                    <small>
                      BLOCK {blockNumber} · SHOWING UP TO 5 OF {configCount}{' '}
                      CONFIGURATIONS
                    </small>
                  )}
                </div>
              </div>

              <div className="config-list">
                {configs.map((entry) => (
                  <article className="config-card" key={String(entry.configId)}>
                    <div className="config-card-number">
                      <span>CONFIGURATION</span>
                      <strong>#{String(entry.configId)}</strong>
                    </div>

                    <div className="config-card-main">
                      <div className="config-card-title">
                        <h3>Launch Configuration #{String(entry.configId)}</h3>
                        <span
                          className={
                            entry.enabled ? 'badge-enabled' : 'badge-disabled'
                          }
                        >
                          <i></i>
                          {entry.enabled ? 'ENABLED' : 'DISABLED'}
                        </span>
                      </div>

                      <div className="config-facts">
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
                        className="text-button"
                        onClick={() => inspectConfig(String(entry.configId))}
                        disabled={busy}
                      >
                        Inspect Full Configuration <span>↗</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>

              <div className="inspector-section">
                <div className="section-heading">
                  <div>
                    <div className="section-kicker">CONFIGURATION INSPECTOR</div>
                    <h2>Inspect by ID</h2>
                    <p>Read the complete configuration and immutable hash.</p>
                  </div>
                </div>

                <div className="inspect-controls">
                  <input
                    type="number"
                    min="1"
                    value={selectedId}
                    onChange={(event) => setSelectedId(event.target.value)}
                    placeholder="Configuration ID"
                  />
                  <button
                    className="primary-button"
                    onClick={() => inspectConfig()}
                    disabled={busy || !connected || !correctNetwork}
                  >
                    {busy ? 'Inspecting...' : 'Inspect Configuration ↗'}
                  </button>
                </div>

                {selectedConfig && (
                  <div className="selected-config">
                    <div className="selected-config-heading">
                      <div>
                        <div className="section-kicker">INSPECTED CONFIGURATION</div>
                        <h3>Configuration #{String(selectedConfig.configId)}</h3>
                      </div>
                      <span
                        className={
                          selectedConfig.enabled
                            ? 'badge-enabled'
                            : 'badge-disabled'
                        }
                      >
                        <i></i>
                        {selectedConfig.enabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                    </div>

                    <div className="selected-facts">
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

                    <div className="hash-row">
                      <span>CONFIGURATION HASH</span>
                      <code>{selectedConfig.configHash}</code>
                    </div>

                    <pre className="json-view">{selectedConfigJSON}</pre>
                  </div>
                )}
              </div>
            </section>
          )}

          {page === 'Config Studio' && (
            <section className="registry-section" style={{ marginTop: 0 }}>
              <div className="section-heading">
                <div>
                  <div className="section-kicker">GIWORA / CONFIGURATION STUDIO</div>
                  <h2>Create Your Own Launch Configuration</h2>
                  <p>
                    Template #24 · GIWA Sepolia · Concentrated graduation. Every
                    team recipient is set to your connected wallet.
                  </p>
                </div>
              </div>

              <div className="selected-config">
                <div className="section-kicker">TEAM WALLET</div>
                <h3 style={{ marginTop: 8 }}>
                  {connected ? shortAddress(account) : 'Connect Your Wallet First'}
                </h3>

                <div className="selected-facts">
                  <div>
                    <span>Configuration Owner</span>
                    <strong>{connected ? shortAddress(account) : '—'}</strong>
                  </div>
                  <div>
                    <span>Partner Recipient</span>
                    <strong>{connected ? shortAddress(account) : '—'}</strong>
                  </div>
                  <div>
                    <span>Liquidity Partner</span>
                    <strong>{connected ? shortAddress(account) : '—'}</strong>
                  </div>
                  <div>
                    <span>Leftover Receiver</span>
                    <strong>{connected ? shortAddress(account) : '—'}</strong>
                  </div>
                </div>
              </div>

              <div className="selected-config" style={{ marginTop: 14 }}>
                <div className="section-kicker">LAUNCH ECONOMICS</div>
                <h3 style={{ marginTop: 8 }}>Template #24</h3>

                <label
                  style={{
                    display: 'block',
                    marginTop: 18,
                    color: '#a69ba9',
                    fontSize: 10,
                  }}
                >
                  Token sale allocation
                </label>
                <input
                  value={saleSupply}
                  onChange={(event) => {
                    setSaleSupply(event.target.value);
                    setPreview(null);
                    setConfigStatus('idle');
                  }}
                  inputMode="decimal"
                  placeholder="1000000"
                  style={{
                    width: '100%',
                    maxWidth: 360,
                    display: 'block',
                    minHeight: 42,
                    marginTop: 8,
                    padding: '0 12px',
                    color: '#f4eee9',
                    background: '#100e12',
                    border: '1px solid #3a323e',
                    borderRadius: 8,
                  }}
                  disabled={busy || Boolean(createdConfig)}
                />

                <label
                  style={{
                    display: 'block',
                    marginTop: 16,
                    color: '#a69ba9',
                    fontSize: 10,
                  }}
                >
                  Graduation quote threshold (WETH)
                </label>
                <input
                  value={quoteThreshold}
                  onChange={(event) => {
                    setQuoteThreshold(event.target.value);
                    setPreview(null);
                    setConfigStatus('idle');
                  }}
                  inputMode="decimal"
                  placeholder="0.001"
                  style={{
                    width: '100%',
                    maxWidth: 360,
                    display: 'block',
                    minHeight: 42,
                    marginTop: 8,
                    padding: '0 12px',
                    color: '#f4eee9',
                    background: '#100e12',
                    border: '1px solid #3a323e',
                    borderRadius: 8,
                  }}
                  disabled={busy || Boolean(createdConfig)}
                />

                <div className="review-note" style={{ marginTop: 18 }}>
                  <strong>Inherited policy</strong>
                  <span>
                    Template fee rates, LP ratios, vesting and graduation mode
                    are inherited. The SDK recalculates curve reserves,
                    migration base threshold, post-migration liquidity and total
                    supply for the selected sale and WETH target.
                  </span>
                </div>

                <button
                  className="primary-button"
                  style={{ marginTop: 20 }}
                  onClick={prepareConfig}
                  disabled={
                    busy ||
                    !connected ||
                    !correctNetwork ||
                    Boolean(createdConfig)
                  }
                >
                  {busy && configStatus === 'preparing'
                    ? 'Calculating Configuration...'
                    : 'Prepare Configuration Preview ↗'}
                </button>
              </div>

              {preview && (
                <div className="selected-config" style={{ marginTop: 14 }}>
                  <div className="selected-config-heading">
                    <div>
                      <div className="section-kicker">
                        UNSIGNED CONFIGURATION PREVIEW
                      </div>
                      <h3>Ready for review</h3>
                    </div>
                    <span className="badge-enabled">
                      <i></i> VALIDATED
                    </span>
                  </div>

                  <div className="selected-facts">
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

                  <div className="hash-row">
                    <span>REVIEW HASH · REQUIRED BEFORE SIGNING</span>
                    <code>{preview.reviewHash}</code>
                  </div>

                  <div className="review-note">
                    <strong>Recipient verification</strong>
                    <span>
                      Configuration Owner, Partner Recipient, Liquidity Partner and
                      Leftover Receiver are all set to {shortAddress(account)}.
                    </span>
                  </div>

                  <div className="json-heading">
                    <strong>Calculated Configuration and Economics</strong>
                    <button
                      className="text-button"
                      onClick={() =>
                        navigator.clipboard
                          ?.writeText(previewJSON)
                          .then(() => setNotice('Preview JSON copied.'))
                          .catch(() => setNotice('Clipboard unavailable.'))
                      }
                    >
                      Copy preview JSON ↗
                    </button>
                  </div>

                  <pre className="json-view">{previewJSON}</pre>

                  <button
                    className="primary-button"
                    style={{ marginTop: 18 }}
                    onClick={createConfig}
                    disabled={busy || !connected || !correctNetwork}
                  >
                    {busy && configStatus === 'creating'
                      ? 'Waiting for wallet confirmation...'
                      : 'Create GIWORA Configuration ↗'}
                  </button>

                  <p
                    style={{
                      color: '#918895',
                      fontSize: 10,
                      lineHeight: 1.7,
                      marginTop: 12,
                    }}
                  >
                    This sends a transaction to the GIWA Sepolia Configuration
                    Registry. Review the exact network, target and gas in
                    your wallet before approving. The transaction creates a new
                    immutable Configuration; it does not create a token.
                  </p>
                </div>
              )}

              {createdConfig && (
                <div className="selected-config" style={{ marginTop: 14 }}>
                  <div className="selected-config-heading">
                    <div>
                      <div className="section-kicker">ON-CHAIN SUCCESS</div>
                      <h3>GIWORA Configuration #{createdConfig.configId}</h3>
                    </div>
                    <span className="badge-enabled">
                      <i></i> CONFIRMED
                    </span>
                  </div>

                  <div className="selected-facts">
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

                  <div className="hash-row">
                    <span>CONFIRMED CONFIGURATION HASH</span>
                    <code>{createdConfig.configHash}</code>
                  </div>

                  <div className="hash-row" style={{ marginTop: 10 }}>
                    <span>TRANSACTION HASH</span>
                    <code>{createdConfig.transactionHash}</code>
                  </div>

                  <button
                    className="primary-button"
                    style={{ marginTop: 18 }}
                    onClick={() => setPage('Token Launch')}
                  >
                    Continue to Token Launch ↗
                  </button>
                </div>
              )}

              {configStatus === 'error' && (
                <div className="review-note" style={{ marginTop: 14 }}>
                  <strong>Configuration Creation Failed</strong>
                  <span>{error}</span>
                </div>
              )}
            </section>
          )}

          {page === 'Token Launch' && (
            <section className="registry-section" style={{ marginTop: 0 }}>
              <div className="section-heading">
                <div>
                  <div className="section-kicker">GIWORA / TOKEN LAUNCH</div>
                  <h2>Launch a Token with Your Configuration</h2>
                  <p>
                    Create a Token and Its Ammora Launch Curve Using Your Own GIWORA
                    Configuration After It Has Been Confirmed.
                  </p>
                </div>
              </div>

              {!createdConfig ? (
                <div className="read-status-panel">
                  <div className="read-status-icon">!</div>
                  <div className="read-status-copy">
                    <strong>No GIWORA configuration has been created yet.</strong>
                    <span>
                      Create and confirm your own GIWORA Configuration in Configuration Studio first.
                      Token launches can only use configurations you created and confirmed.
                    </span>
                    <button
                      className="text-button"
                      onClick={() => setPage('Config Studio')}
                    >
                      Go to Configuration Studio ↗
                    </button>
                  </div>
                </div>
              ) : (
                <div className="selected-config">
                  <div className="section-kicker">CONFIRMED GIWORA CONFIGURATION</div>
                  <h3 style={{ marginTop: 8 }}>
                    Configuration #{createdConfig.configId}
                  </h3>
                  <p style={{ color: '#938895', fontSize: 10 }}>
                    {createdConfig.configHash}
                  </p>

                  <label
                    style={{
                      display: 'block',
                      marginTop: 18,
                      color: '#a69ba9',
                      fontSize: 10,
                    }}
                  >
                    Token name
                  </label>
                  <input
                    value={tokenName}
                    onChange={(event) => setTokenName(event.target.value)}
                    placeholder="GIWORA Token"
                    disabled={busy}
                    style={{
                      width: '100%',
                      maxWidth: 440,
                      display: 'block',
                      minHeight: 42,
                      marginTop: 8,
                      padding: '0 12px',
                      color: '#f4eee9',
                      background: '#100e12',
                      border: '1px solid #3a323e',
                      borderRadius: 8,
                    }}
                  />

                  <label
                    style={{
                      display: 'block',
                      marginTop: 16,
                      color: '#a69ba9',
                      fontSize: 10,
                    }}
                  >
                    Token symbol
                  </label>
                  <input
                    value={tokenSymbol}
                    onChange={(event) =>
                      setTokenSymbol(event.target.value.toUpperCase())
                    }
                    placeholder="GWR"
                    maxLength={10}
                    disabled={busy}
                    style={{
                      width: '100%',
                      maxWidth: 440,
                      display: 'block',
                      minHeight: 42,
                      marginTop: 8,
                      padding: '0 12px',
                      color: '#f4eee9',
                      background: '#100e12',
                      border: '1px solid #3a323e',
                      borderRadius: 8,
                    }}
                  />

                  <label
                    style={{
                      display: 'block',
                      marginTop: 16,
                      color: '#a69ba9',
                      fontSize: 10,
                    }}
                  >
                    Public metadata JSON URI
                  </label>
                  <input
                    value={metadataURI}
                    onChange={(event) => setMetadataURI(event.target.value)}
                    placeholder="https://.../metadata.json or ipfs://..."
                    disabled={busy}
                    style={{
                      width: '100%',
                      maxWidth: 600,
                      display: 'block',
                      minHeight: 42,
                      marginTop: 8,
                      padding: '0 12px',
                      color: '#f4eee9',
                      background: '#100e12',
                      border: '1px solid #3a323e',
                      borderRadius: 8,
                    }}
                  />

                  <div className="review-note" style={{ marginTop: 18 }}>
                    <strong>Metadata requirement</strong>
                    <span>
                      The URI must point to a public JSON metadata document. Do
                      not use example.com or a placeholder address. We must
                      upload and verify the actual metadata before launch.
                    </span>
                  </div>

                  <button
                    className="primary-button"
                    style={{ marginTop: 20 }}
                    onClick={createToken}
                    disabled={busy || !correctNetwork || !metadataURI.trim()}
                  >
                    {busy && launchStatus === 'preparing'
                      ? 'Preparing Token...'
                      : 'Create Token ↗'}
                  </button>

                  {createdLaunch && (
                    <div className="review-note" style={{ marginTop: 18 }}>
                      <strong>Token Creation Confirmed</strong>
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
              )}
            </section>
          )}

          <section className="bottom-banner">
            <div>
              <div className="section-kicker">GIWORA LAUNCHPAD</div>
              <h2>Build the next project on GIWA.</h2>
              <p>Independent project. Built with Ammora SDK.</p>
            </div>
            <div className="banner-mark">G.</div>
          </section>

          <footer className="footer">
            <span>© 2026 GIWORA</span>
            <span>INDEPENDENT WEB3 LAUNCHPAD</span>
            <span>GIWA SEPOLIA · AMMORA SDK</span>
          </footer>
        </div>
      </main>

      {notice && (
        <div className="toast" onClick={() => setNotice('')}>
          <span>{notice}</span>
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
    </div>
  );
}
