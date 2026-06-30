const GAS_API_URL = "https://script.google.com/macros/s/AKfycby9csZsJaxn3X13T2UmCTT84oe4UgZA6Dk8YwLtzAJI7SLTV6TRpBxrEErWBEUZGYMy/exec";
const LIFF_ID = "2008914129-GhF8Lno6";

const { createApp } = Vue;

const CONFIG = {
  CAT_EQUIPMENT: '設備使用費', 
  PRICE_PER_HR: 100, 
  BINDING_GROUPS: [
    { triggers: ['TPLMKIT001', 'TPLMKIT005'], target: 'TPLMKIT002', targetName: '縫紉耗材(小時)' },
    { triggers: ['TPLMKIT003'], target: 'TPLMKIT004', targetName: '3D列印線材(小時)' }
  ]
};

// 封裝呼叫 GAS API 的共用函式
async function callApi(action, data = {}) {
  try {
    const response = await fetch(GAS_API_URL, {
      method: 'POST',
      body: JSON.stringify({ action: action, data: data }),
      // 使用 text/plain 避免 OPTIONS Preflight 請求問題
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
    const result = await response.json();
    return result;
  } catch (error) {
    console.error("API Error:", error);
    return { success: false, message: "網路連線錯誤或 API 網址設定錯誤" };
  }
}

const app = createApp({
  data() {
    return {
      initLoading: true,
      initMessage: "系統初始化中...",
      loading: true, 
      processing: false, 
      checkingCoupon: false,
      currentUser: null,    
      showMobileCart: false, 
      todayBookings: [],
      products: [], 
      cart: [], 
      coupons: [], 
      searchQuery: '', 
      selectedCategory: 'all',
      mode: 'sales', 
      operatorName: '', 
      customerName: '', 
      hasStudentId: false, 
      couponInput: '', 
      manualDiscount: 0, 
      manualReason: '',
      activityName: '', 
      internalDate: new Date().toISOString().split('T')[0],
      showBookingList: false,
      longPressTimer: null,
      longPressInterval: null,
    }
  },
  computed: {
    isAdmin() {
      return this.currentUser && (this.currentUser.role === '管理員' || this.currentUser.role === '館員');
    },
    cartItemCount() {
      return this.cart.reduce((sum, item) => sum + item.qty, 0);
    },
    categories() { return Array.from(new Set(this.products.map(p => p.category).filter(c => c))); },
    filteredProducts() {
      let list = this.products;
      if (this.selectedCategory !== 'all') list = list.filter(p => p.category === this.selectedCategory);
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        list = list.filter(p => p.name.toLowerCase().includes(q) || String(p.sku).toLowerCase().includes(q));
      }
      return list;
    },
    pricing() {
       // ============================================
       // 【請注意】由於您傳送的程式碼被系統截斷，這裡的計價邏輯遺失了！
       // 請將您原本 pos.html 中 pricing computed 內的所有邏輯複製貼上來覆蓋這裡！
       // ============================================
       let finalTotal = 0;
       this.cart.forEach(item => { finalTotal += (item.price * item.qty); });
       return { finalTotal: finalTotal, rawEquip: 0, rawBoundMat: 0, rawGenMat: 0, matToEquipDisc: 0, studentDisc: 0, totalCouponDisc: 0 };
    }
  },
  async mounted() {
    await this.initLiff();
  },
  methods: {
    // 初始化 LIFF 並自動登入
    async initLiff() {
      this.initLoading = true;
      try {
        await liff.init({ liffId: LIFF_ID });
        
        // 如果還沒登入，就要求登入
        if (!liff.isLoggedIn()) {
           liff.login();
           return;
        }
        
        this.initMessage = "驗證館員身分中...";
        const profile = await liff.getProfile();
        
        // 呼叫後端驗證權限
        const result = await callApi('verifyUser', { lineId: profile.userId });
        
        if (result.success) {
           this.currentUser = result.user;
           this.operatorName = this.currentUser.name;
           this.initLoading = false; // 驗證成功，關閉全螢幕載入畫面，直接進入 POS
           this.loadInitialData();
        } else {
           this.initMessage = "無系統存取權限！請聯絡管理員。";
           // alert(result.message);
        }
      } catch(err) {
         console.error(err);
         let errorMsg = err.message ? err.message : JSON.stringify(err);
         this.initMessage = "LIFF 錯誤: " + errorMsg;
      }
    },

    // 取得商品與預約清單
    async loadInitialData() {
      this.loading = true;
      try {
         const [prodRes, bookingRes] = await Promise.all([
            callApi('getProducts'),
            callApi('getTodayBookings')
         ]);
         
         if (prodRes.success) this.products = prodRes.data;
         if (bookingRes.success) this.todayBookings = bookingRes.data;
      } catch (err) {
         console.error("載入資料失敗", err);
      } finally {
         this.loading = false;
      }
    },

    // 呼叫 LINE LIFF 原生掃描功能
    async scanCode() {
      if (!liff.isInClient() || !liff.scanCodeV2) {
          alert("請在手機 LINE App 內使用此功能，或您的設備不支援掃碼。");
          return;
      }
      try {
          const result = await liff.scanCodeV2();
          if (result && result.value) {
              this.handleScanResult(result.value);
          }
      } catch (error) {
          console.error("Scan error", error);
      }
    },

    // 處理掃描後的字串 (判斷是商品 SKU 還是折價券)
    handleScanResult(text) {
       text = text.trim();
       const product = this.products.find(p => String(p.sku).toUpperCase() === text.toUpperCase());
       if (product) {
           this.addToCart(product);
           alert(`已加入購物車: ${product.name}`);
       } else {
           // 找不到商品，當作折價券代碼試試看
           this.couponInput = text;
           this.addCoupon();
       }
    },

    // 加入折價券 (修改為 callApi)
    async addCoupon() {
       if (!this.couponInput) return;
       this.checkingCoupon = true;
       const res = await callApi('checkCoupon', { code: this.couponInput });
       if (res.success) {
           this.coupons.push(res.data);
           this.couponInput = '';
       } else {
           alert(res.message);
       }
       this.checkingCoupon = false;
    },

    // 結帳送出訂單 (修改為 callApi)
    async submitOrder() {
       this.processing = true;
       
       const orderData = { 
           orderId: (this.mode === 'internal' ? 'USE-' : 'POS-') + new Date().getTime(),
           customerName: this.mode === 'internal' ? this.activityName : this.customerName,
           operatorName: this.operatorName,
           items: this.cart,
           coupons: this.coupons,
           note: this.manualDiscount > 0 ? `手動折抵 ${this.manualDiscount} (${this.manualReason})` : ""
       };

       const res = await callApi('processOrder', orderData);
       this.processing = false;
       
       if (res.success) {
           alert("結帳完成！");
           this.cart = [];
           this.coupons = [];
           this.customerName = '';
           this.manualDiscount = 0;
           this.manualReason = '';
           this.showMobileCart = false; // 結帳完收起手機購物車
       } else {
           alert("結帳失敗：" + res.message);
       }
    },

    // ============================================
    // 【請注意】以下為基本購物車操作，由於您的原始碼被截斷，
    // 請將您原本的 addToCart 等完整邏輯覆蓋這裡，以確保綁定耗材等功能正常運作！
    // ============================================

    addToCart(item) {
       if(item.stock <= 0 && item.stock !== 999999999) {
           alert("庫存不足");
           return;
       }
       const exist = this.cart.find(c => c.sku === item.sku);
       if (exist) { 
           exist.qty++; 
       } else { 
           this.cart.push({...item, qty: 1}); 
       }
    },

    removeFromCart(index) { this.cart.splice(index, 1); },
    removeCoupon(index) { this.coupons.splice(index, 1); },
    
    startChangeQty(index, delta) {
        const item = this.cart[index];
        if (item.qty + delta > 0) item.qty += delta;
        else if (item.qty + delta === 0) this.removeFromCart(index);
    },
    stopChangeQty() {},
    
    selectBooking(name) { this.customerName = name; this.showBookingList = false; },
    hideBookingList() { setTimeout(() => this.showBookingList = false, 200); },
    getCouponTypeLabel(type) { 
        if(type==='EQUIPMENT') return '設備';
        if(type==='MATERIAL') return '耗材';
        if(type==='REDEMPTION') return '兌換';
        return type; 
    },
    goToAdmin() { window.location.href = "?p=admin"; } // 注意：後台需要另外處理
  }
});

app.mount('#app');
