// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    function WETH() external pure returns (address);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract MEVBot is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Events
    event TradeExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        string strategy
    );
    event Deposited(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount);
    event RouterUpdated(string name, address router);

    // Router registry
    struct Router {
        address routerAddress;
        address factory;
        bool isV3;
        bool active;
    }

    mapping(string => Router) public routers;
    string[] public routerNames;

    // Tracked tokens for withdrawAll
    address[] public trackedTokens;
    mapping(address => bool) public isTracked;

    // WETH address (varies per chain)
    address public immutable WETH;

    // Pause state
    bool public paused;

    modifier whenNotPaused() {
        require(!paused, "Bot is paused");
        _;
    }

    constructor(address _weth) Ownable(msg.sender) {
        WETH = _weth;
    }

    // ============ RECEIVE ETH ============
    receive() external payable {
        emit Deposited(address(0), msg.value);
    }

    // ============ ROUTER MANAGEMENT ============
    function addRouter(
        string calldata name,
        address _router,
        address _factory,
        bool _isV3
    ) external onlyOwner {
        routers[name] = Router(_router, _factory, _isV3, true);
        routerNames.push(name);
        emit RouterUpdated(name, _router);
    }

    function toggleRouter(string calldata name, bool active) external onlyOwner {
        routers[name].active = active;
    }

    // ============ TRADING - V2 ============
    function swapV2ExactETHForTokens(
        string calldata routerName,
        uint256 amountOutMin,
        address[] calldata path,
        uint256 deadline
    ) external onlyOwner whenNotPaused nonReentrant returns (uint256[] memory) {
        Router memory r = routers[routerName];
        require(r.active && !r.isV3, "Invalid V2 router");

        uint256 ethAmount = address(this).balance;
        require(ethAmount > 0, "No ETH balance");

        uint256[] memory amounts = IUniswapV2Router02(r.routerAddress)
            .swapExactETHForTokens{value: ethAmount}(
                amountOutMin,
                path,
                address(this),
                deadline
            );

        _trackToken(path[path.length - 1]);
        emit TradeExecuted(address(0), path[path.length - 1], ethAmount, amounts[amounts.length - 1], "v2_buy");
        return amounts;
    }

    function swapV2ExactTokensForETH(
        string calldata routerName,
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        uint256 deadline
    ) external onlyOwner whenNotPaused nonReentrant returns (uint256[] memory) {
        Router memory r = routers[routerName];
        require(r.active && !r.isV3, "Invalid V2 router");

        IERC20(path[0]).forceApprove(r.routerAddress, amountIn);

        uint256[] memory amounts = IUniswapV2Router02(r.routerAddress)
            .swapExactTokensForETH(
                amountIn,
                amountOutMin,
                path,
                address(this),
                deadline
            );

        emit TradeExecuted(path[0], address(0), amountIn, amounts[amounts.length - 1], "v2_sell");
        return amounts;
    }

    function swapV2ExactTokensForTokens(
        string calldata routerName,
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        uint256 deadline
    ) external onlyOwner whenNotPaused nonReentrant returns (uint256[] memory) {
        Router memory r = routers[routerName];
        require(r.active && !r.isV3, "Invalid V2 router");

        IERC20(path[0]).forceApprove(r.routerAddress, amountIn);

        uint256[] memory amounts = IUniswapV2Router02(r.routerAddress)
            .swapExactTokensForTokens(
                amountIn,
                amountOutMin,
                path,
                address(this),
                deadline
            );

        _trackToken(path[path.length - 1]);
        emit TradeExecuted(path[0], path[path.length - 1], amountIn, amounts[amounts.length - 1], "v2_swap");
        return amounts;
    }

    // ============ TRADING - V3 ============
    function swapV3ExactInput(
        string calldata routerName,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMin
    ) external onlyOwner whenNotPaused nonReentrant returns (uint256) {
        Router memory r = routers[routerName];
        require(r.active && r.isV3, "Invalid V3 router");

        IERC20(tokenIn).forceApprove(r.routerAddress, amountIn);

        uint256 amountOut = IUniswapV3Router(r.routerAddress).exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );

        _trackToken(tokenOut);
        emit TradeExecuted(tokenIn, tokenOut, amountIn, amountOut, "v3_swap");
        return amountOut;
    }

    // ============ SANDWICH SPECIFIC ============
    // Frontrun: buy token with specific ETH amount
    function sandwichBuy(
        string calldata routerName,
        uint256 ethAmount,
        uint256 amountOutMin,
        address[] calldata path,
        uint256 deadline
    ) external onlyOwner whenNotPaused nonReentrant returns (uint256[] memory) {
        Router memory r = routers[routerName];
        require(r.active && !r.isV3, "Invalid V2 router");
        require(ethAmount <= address(this).balance, "Insufficient ETH");

        uint256[] memory amounts = IUniswapV2Router02(r.routerAddress)
            .swapExactETHForTokens{value: ethAmount}(
                amountOutMin,
                path,
                address(this),
                deadline
            );

        _trackToken(path[path.length - 1]);
        emit TradeExecuted(address(0), path[path.length - 1], ethAmount, amounts[amounts.length - 1], "sandwich_buy");
        return amounts;
    }

    // Backrun: sell all tokens back to ETH
    function sandwichSell(
        string calldata routerName,
        address token,
        uint256 amountOutMin,
        uint256 deadline
    ) external onlyOwner whenNotPaused nonReentrant returns (uint256[] memory) {
        Router memory r = routers[routerName];
        require(r.active && !r.isV3, "Invalid V2 router");

        uint256 tokenBalance = IERC20(token).balanceOf(address(this));
        require(tokenBalance > 0, "No token balance");

        IERC20(token).forceApprove(r.routerAddress, tokenBalance);

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = WETH;

        uint256[] memory amounts = IUniswapV2Router02(r.routerAddress)
            .swapExactTokensForETH(
                tokenBalance,
                amountOutMin,
                path,
                address(this),
                deadline
            );

        emit TradeExecuted(token, address(0), tokenBalance, amounts[amounts.length - 1], "sandwich_sell");
        return amounts;
    }

    // ============ ARBITRAGE ============
    // Buy on router A, sell on router B
    function arbitrage(
        string calldata buyRouter,
        string calldata sellRouter,
        uint256 ethAmount,
        address token,
        uint256 minProfit,
        uint256 deadline
    ) external onlyOwner whenNotPaused nonReentrant {
        require(ethAmount <= address(this).balance, "Insufficient ETH");

        Router memory rBuy = routers[buyRouter];
        Router memory rSell = routers[sellRouter];
        require(rBuy.active && rSell.active, "Router inactive");

        uint256 ethBefore = address(this).balance;

        // Buy token on router A
        address[] memory buyPath = new address[](2);
        buyPath[0] = WETH;
        buyPath[1] = token;

        IUniswapV2Router02(rBuy.routerAddress)
            .swapExactETHForTokens{value: ethAmount}(0, buyPath, address(this), deadline);

        // Sell token on router B
        uint256 tokenBal = IERC20(token).balanceOf(address(this));
        IERC20(token).forceApprove(rSell.routerAddress, tokenBal);

        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = WETH;

        IUniswapV2Router02(rSell.routerAddress)
            .swapExactTokensForETH(tokenBal, 0, sellPath, address(this), deadline);

        uint256 ethAfter = address(this).balance;
        require(ethAfter >= ethBefore - ethAmount + minProfit, "Not profitable");

        _trackToken(token);
        emit TradeExecuted(address(0), address(0), ethAmount, ethAfter - (ethBefore - ethAmount), "arbitrage");
    }

    // ============ FUND & WITHDRAW ============
    function deposit() external payable onlyOwner {
        emit Deposited(address(0), msg.value);
    }

    function withdrawAll() external onlyOwner nonReentrant {
        // 1. Withdraw all tracked tokens first
        for (uint256 i = 0; i < trackedTokens.length; i++) {
            address token = trackedTokens[i];
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (balance > 0) {
                IERC20(token).safeTransfer(owner(), balance);
                emit Withdrawn(token, balance);
            }
        }

        // 2. Withdraw WETH if any
        uint256 wethBal = IWETH(WETH).balanceOf(address(this));
        if (wethBal > 0) {
            IWETH(WETH).withdraw(wethBal);
        }

        // 3. Withdraw all ETH last
        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0) {
            (bool sent, ) = owner().call{value: ethBalance}("");
            require(sent, "ETH transfer failed");
            emit Withdrawn(address(0), ethBalance);
        }
    }

    function withdrawToken(address token) external onlyOwner nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance");
        IERC20(token).safeTransfer(owner(), balance);
        emit Withdrawn(token, balance);
    }

    function withdrawETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH");
        (bool sent, ) = owner().call{value: balance}("");
        require(sent, "Transfer failed");
        emit Withdrawn(address(0), balance);
    }

    // ============ CONTROL ============
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    // ============ VIEW ============
    function getETHBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function getTokenBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function getTrackedTokens() external view returns (address[] memory) {
        return trackedTokens;
    }

    function getRouterCount() external view returns (uint256) {
        return routerNames.length;
    }

    // ============ INTERNAL ============
    function _trackToken(address token) internal {
        if (!isTracked[token]) {
            isTracked[token] = true;
            trackedTokens.push(token);
        }
    }

    // Emergency: call any contract (for edge cases)
    function emergencyCall(
        address target,
        bytes calldata data,
        uint256 value
    ) external onlyOwner nonReentrant returns (bytes memory) {
        (bool success, bytes memory result) = target.call{value: value}(data);
        require(success, "Call failed");
        return result;
    }
}
