# GIWORA

**An independent token launchpad built on GIWA Sepolia with the Ammora SDK.**

Live: https://giwora.vercel.app/

GIWORA lets you create your own launch configuration on top of a reviewed Ammora template and then launch a token with it, all from the browser and signed by your own wallet. There is no backend: every read and write goes straight to GIWA Sepolia.

## How it works

1. **Connect Wallet.** Connect an injected wallet (for example MetaMask) and switch to GIWA Sepolia (chain ID 91342). The app can add the network for you.
2. **Registry.** Read launch configurations directly from the Ammora V4 Config Registry and inspect any configuration by ID. Reading works without a wallet.
3. **Config Studio.** Choose a sale allocation and a graduation threshold. GIWORA derives the bonding curve, migration reserve, post-migration liquidity and total supply from Template #24 (concentrated graduation) and shows an unsigned preview with a review hash. All team roles are set to your wallet.
4. **Create configuration.** Sign one transaction. The app re-checks the template hash and review hash before signing, then verifies the on-chain receipt against what you reviewed. Your confirmed configuration is remembered in this browser, so you can refresh the page and still launch a token later.
5. **Token Launch.** Create a token and its Ammora launch curve from your confirmed configuration. Name, symbol and a public metadata JSON URI are prefilled so you can try it right away.

## Ammora SDK usage

GIWORA uses `@ammora-protocol/sdk` for all protocol logic:

- `giwaSepoliaAutoRouteDeployment`, `giwaSepoliaAutoRoute`: deployment catalog and finality settings
- `resolveAmmoraFinalizedHead`, `verifyAmmoraV4CoreAtBlock`: read at a finalized block and verify the core contracts
- `getAmmoraV4NextConfigId`, `getAmmoraV4ConfigAtBlock`: registry reads
- `buildSingleSegmentCurve`, `concentratedDepositQuote`, `assertAmmoraV4Config`: curve and economics derivation and validation
- `buildCreateAmmoraV4Config`, `parseAmmoraV4ConfigCreatedReceipt`: create and confirm a configuration
- `buildCreateAmmoraV4Launch`, `parseAmmoraV4LaunchCreatedReceipt`: create and confirm a token launch

## Try it

You need a browser wallet and a little GIWA Sepolia test ETH.

- Faucet: https://faucet.giwa.io/
- Bridge: https://sepolia-bridge.giwa.io/

Then open the site, connect your wallet, go to **Config Studio**, prepare and create a configuration, and continue to **Token Launch**.

## Run locally

```bash
npm install
npm run dev      # development server
npm run build    # production build in dist/
npm run preview  # serve the production build
```

Built with React, Vite and viem.

## Project information

- **Network:** GIWA Sepolia (testnet), chain ID 91342
- **Template:** Ammora Template #24, concentrated graduation
- **SDK:** `@ammora-protocol/sdk`

## Disclaimer

GIWORA is an independent community-built project and is not an official Ammora product. It is deployed on a test network for testing and experimentation.
