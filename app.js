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
        if (this.mode === 'internal') return { finalTotal: 0 };
        let rawEquip = 0, rawBoundMat = 0, rawGenMat = 0;
        const boundMatSkus = new Set(CONFIG.BINDING_GROUPS.map(g => g.target));
        
        this.cart.forEach(item => {
          if (!item.isRedemption) {
            const subtotal = item.price * item.qty;
            if (item.category === CONFIG.CAT_EQUIPMENT) rawEquip += subtotal;
            else if (boundMatSkus.has(item.sku)) rawBoundMat += subtotal;
            else rawGenMat += subtotal;
          }
        });

        const hasBindingGroup = rawBoundMat > 0;
        let payEquip = rawEquip;
        let payBound = rawBoundMat;
        let payGen = rawGenMat;

        let totalMatCredit = rawBoundMat + rawGenMat;
        let matToEquipDisc = Math.min(payEquip, totalMatCredit);
        payEquip -= matToEquipDisc;
        
        let equipDeficitAfterBound = Math.max(0, rawEquip - rawBoundMat);
        let genUsedForEquip = Math.min(rawGenMat, equipDeficitAfterBound);
        let genRemainingCredit = rawGenMat - genUsedForEquip;
        
        let genToBoundDisc = 0;
        // [開關] 耗材抵綁定折扣：目前已利用 /* 與 */ 註解關閉
        /*
        if (hasBindingGroup && genRemainingCredit > 0) {
           genToBoundDisc = Math.min(payBound, genRemainingCredit);
           payBound -= genToBoundDisc;
        }
        */

        let studentDisc = 0;
        if (this.hasStudentId) {
          let limit = CONFIG.PRICE_PER_HR;
          let dedE = Math.min(payEquip, limit);
          payEquip -= dedE;
          limit -= dedE;
          studentDisc += dedE;
          if (hasBindingGroup && limit > 0) {
            let dedM = Math.min(payBound, limit);
            payBound -= dedM;
            studentDisc += dedM;
          }
        }

        let totalCouponDisc = 0;
        let billBeforeCoupon = { equip: payEquip, bound: payBound, gen: payGen };
        
        this.coupons.forEach(cp => {
          let val = cp.value;
          let applied = 0;
          if (cp.type === 'EQUIPMENT') {
            let dedE = Math.min(payEquip, val);
            payEquip -= dedE; val -= dedE; applied += dedE;
            if (hasBindingGroup && val > 0) {
               let dedM = Math.min(payBound, val);
               payBound -= dedM; val -= dedM; applied += dedM;
            }
          } else if (cp.type === 'MATERIAL') {
            if (val > 0 && payBound > 0) {
              let dedB = Math.min(payBound, val);
              payBound -= dedB; val -= dedB; applied += dedB;
            }
            if (val > 0 && payGen > 0) {
              let dedG = Math.min(payGen, val);
              payGen -= dedG; applied += dedG;
            }
          }
          cp.appliedVal = applied; 
          totalCouponDisc += applied;
        });

        let final = payEquip + payBound + payGen;
        final = Math.max(0, final - this.manualDiscount);
        return {
          rawEquip, rawBoundMat, rawGenMat,
          matToEquipDisc, genToBoundDisc,
          studentDisc, totalCouponDisc,
          billBeforeCoupon,
          finalTotal: final
        };
    }
  },
  watch: {
    cart: {
      handler(newCart) {
        if (this.mode === 'internal') return; 
        let targetQtyMap = {};
        CONFIG.BINDING_GROUPS.forEach(group => {
          let totalHours = 0;
          newCart.forEach(item => { 
              if (!item.isRedemption && group.triggers.includes(item.sku)) totalHours += item.qty; 
          });
          if (totalHours > 0) targetQtyMap[group.target] = { qty: totalHours, name: group.targetName };
        });
        CONFIG.BINDING_GROUPS.forEach(group => {
           const targetSku = group.target;
           const targetData = targetQtyMap[targetSku];
           const idx = this.cart.findIndex(i => i.sku === targetSku);
           if (targetData) {
             if (idx === -1) this.addBoundItemToCart(targetSku, targetData.qty, targetData.name);
             else {
               if (this.cart[idx].qty !== targetData.qty) this.cart[idx].qty = targetData.qty;
               this.cart[idx].isAutoAdded = true; 
             }
           } else {
             if (idx !== -1 && this.cart[idx].isAutoAdded) this.cart.splice(idx, 1);
           }
        });
        this.validateCoupons();
      }, deep: true
    },
    hasStudentId() { this.validateCoupons(); }
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
        
        if (!liff.isLoggedIn()) {
           liff.login();
           return;
        }
        
        this.initMessage = "驗證館員身分中...";
        const profile = await liff.getProfile();
        
        const result = await callApi('verifyUser', { lineId: profile.userId });
        
        if (result.success) {
           this.currentUser = result.user;
           this.operatorName = this.currentUser.name;
           this.initLoading = false; 
           this.initData();
        } else {
           this.initMessage = "無系統存取權限！請聯絡管理員。";
        }
      } catch(err) {
         console.error(err);
         let errorMsg = err.message ? err.message : JSON.stringify(err);
         this.initMessage = "LIFF 錯誤: " + errorMsg;
      }
    },

    // 取得商品與預約清單
    async initData() {
      this.loading = true;
      try {
         const [prodRes, bookingRes] = await Promise.all([
            callApi('getProducts'),
            callApi('getTodayBookings')
         ]);
         
         if (prodRes.success) this.products = prodRes.data;
         
         if (bookingRes.success) {
             if (!bookingRes.data || bookingRes.data.length === 0) {
                 this.todayBookings = [{ name: "測試人員", display: "測試人員 (系統測試用)" }];
             } else {
                 this.todayBookings = bookingRes.data;
             }
         }
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

    // 處理掃描後的字串
    handleScanResult(text) {
       text = text.trim();
       const product = this.products.find(p => String(p.sku).toUpperCase() === text.toUpperCase());
       if (product) {
           this.addToCart(product);
           alert(`已加入購物車: ${product.name}`);
       } else {
           this.couponInput = text;
           this.addCoupon();
       }
    },

    onCustomerSelect() {
      console.log("已選取讀者:", this.customerName);
    },
    
    selectBooking(name) {
      this.customerName = name;
      this.showBookingList = false;
      this.onCustomerSelect(); 
    },

    hideBookingList() {
      setTimeout(() => {
        this.showBookingList = false;
      }, 150);
    },

    validateCoupons() {
      this.$nextTick(() => {
          const validCoupons = this.coupons.filter(cp => {
              if (cp.type === 'REDEMPTION') return true;
              return cp.appliedVal > 0;
          });
          if (validCoupons.length < this.coupons.length) this.coupons = validCoupons;
      });
    },

    getCouponTypeLabel(type) {
      if(type === 'EQUIPMENT') return '設備券';
      if(type === 'MATERIAL') return '耗材券';
      if(type === 'REDEMPTION') return '兌換券';
      return '通用';
    },

    async addCoupon() {
      if (!this.couponInput) return;
      
      const inputUpper = this.couponInput.trim().toUpperCase();
      if (this.coupons.find(c => c.code.toUpperCase() === inputUpper)) {
        return alert("此折價券已加入");
      }
      
      this.checkingCoupon = true;
      const res = await callApi('checkCoupon', { code: this.couponInput });
      this.checkingCoupon = false;
      
      if (res.success) {
        const type = res.data.type;
        const bill = this.pricing.billBeforeCoupon;
        if (type === 'EQUIPMENT' && bill.equip + bill.bound <= 0) return alert("設備與綁定耗材費已全數折抵完畢。");
        if (type === 'MATERIAL' && bill.bound + bill.gen <= 0) return alert("耗材費用已全數折抵完畢。");
        
        this.coupons.push(res.data);
        this.couponInput = '';
        if (type === 'REDEMPTION') {
          const keyword = res.data.name.replace("兌換券","").replace("兌換","").trim();
          const targetProduct = this.products.find(p => p.name.includes(keyword));
          if (targetProduct) {
            this.addToCart(targetProduct, true, res.data.code);
            alert(`已自動加入兌換商品：${targetProduct.name} (贈品)`);
          } else alert(`請注意：找不到對應商品 "${keyword}"，請手動加入購物車以利核銷。`);
        }
      } else {
        alert(res.message);
      }
    },

    removeCoupon(index) { 
      const cp = this.coupons[index];
      if (cp.type === 'REDEMPTION') {
          const itemIdx = this.cart.findIndex(i => i.sourceCoupon === cp.code);
          if (itemIdx !== -1) this.cart.splice(itemIdx, 1);
      }
      this.coupons.splice(index, 1); 
    },

    addBoundItemToCart(sku, qty, defaultName) {
      const prod = this.products.find(p => p.sku === sku);
      const maxStock = prod ? prod.stock : 999;
      const price = prod ? prod.price : CONFIG.PRICE_PER_HR;
      const name = prod ? prod.name : defaultName;
      if (maxStock > 0) this.cart.push({sku, name, price, qty, category: '耗材', isAutoAdded: true, maxStock});
    },

    addToCart(item, isRedemption = false, sourceCoupon = null) {
      if (item.stock <= 0 && item.stock !== 999999999) {
          alert("庫存不足");
          return;
      }
      if (isRedemption) {
         this.cart.push({ ...item, qty: 1, isAutoAdded: false, maxStock: item.stock, isRedemption: true, sourceCoupon: sourceCoupon });
      } else {
         const existing = this.cart.find(i => i.sku === item.sku && !i.isRedemption);
         if (existing) {
           if (existing.qty < existing.maxStock || existing.maxStock === 999999999) existing.qty++;
         } else {
           this.cart.push({ ...item, qty: 1, isAutoAdded: false, maxStock: item.stock, isRedemption: false });
         }
      }
    },

    updateQty(index, change, isRapid = false) {
      const item = this.cart[index];
      if (item.isAutoAdded || item.isRedemption) return;
      
      const newQty = item.qty + change;
      
      if (newQty > item.maxStock && item.maxStock !== 999999999) {
         if (!isRapid) alert("數量不能大於庫存");
         return;
      }
      
      if (newQty > 0) item.qty = newQty;
      else {
         this.removeFromCart(index);
         this.stopChangeQty(); 
      }
    },

    startChangeQty(index, change) {
      this.updateQty(index, change);
      this.stopChangeQty();
      this.longPressTimer = setTimeout(() => {
        this.longPressInterval = setInterval(() => {
          this.updateQty(index, change, true);
        }, 100);
      }, 500);
    },

    stopChangeQty() {
      clearTimeout(this.longPressTimer);
      clearInterval(this.longPressInterval);
      this.longPressTimer = null;
      this.longPressInterval = null;
    },

    removeFromCart(index) { 
        const item = this.cart[index];
        if (item.sourceCoupon) {
            const cpIdx = this.coupons.findIndex(c => c.code === item.sourceCoupon);
            if (cpIdx !== -1) this.coupons.splice(cpIdx, 1);
        }
        this.cart.splice(index, 1); 
    },

    async submitOrder() {
      if (!this.operatorName) return alert("請輸入經手人");
      if (!this.customerName) return alert("請輸入讀者/領用人");
      if (this.mode === 'internal' && (!this.activityName || !this.internalDate)) return alert("請填寫活動名稱與日期");
      if (this.mode === 'sales' && this.manualDiscount > 0 && !this.manualReason) return alert("請輸入手動折抵原因");
      
      if (this.mode === 'sales' && !confirm(`總金額 $${this.pricing.finalTotal}，確認結帳？`)) return;

      this.processing = true;
      let noteStr = this.mode === 'sales' ? "" : `[館員領用] ${this.activityName}`;
      if (this.mode === 'sales') {
          if(this.hasStudentId) noteStr += "[學生證] ";
          if(this.manualDiscount > 0) noteStr += `[手動折抵$${this.manualDiscount}: ${this.manualReason}] `;
      }

      const validCoupons = this.coupons.filter(c => c.appliedVal > 0 || c.type === 'REDEMPTION');
      
      const orderData = {
        orderId: this.generateOrderId(),
        items: JSON.parse(JSON.stringify(this.cart)), 
        operatorName: this.operatorName,
        customerName: this.customerName,
        isInternal: this.mode === 'internal',
        coupons: validCoupons, 
        note: noteStr,
        customDate: this.mode === 'internal' ? this.internalDate : null
      };

      if (this.mode === 'sales') {
          const rawSum = this.pricing.rawEquip + this.pricing.rawBoundMat + this.pricing.rawGenMat;
          const discountAmt = rawSum - this.pricing.finalTotal;
          if (discountAmt > 0) {
              orderData.items.push({ sku: 'DISCOUNT', name: '系統折抵合計', qty: 1, price: -discountAmt, total: -discountAmt });
          }
      } else {
          orderData.items.forEach(i => { i.price = 0; i.total = 0; });
      }

      const res = await callApi('processOrder', orderData);
      
      if (res.success) {
          alert(res.message);
          this.cart = []; 
          this.customerName = ''; 
          this.coupons = []; 
          this.manualDiscount = 0; 
          this.manualReason = ''; 
          this.hasStudentId = false;
          this.activityName = ''; 
          this.processing = false;
          this.showMobileCart = false;

          // 強制重新讀取庫存
          this.loading = true;
          this.initData();     
      } else {
          alert("結帳失敗: " + res.message);
          this.processing = false;
      }
    },

    generateOrderId() {
      const d = new Date();
      const dateStr = d.toISOString().slice(0,10).replace(/-/g,'');
      return (this.mode === 'internal' ? 'INT-' : '') + dateStr + '-' + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    },

    logout() {
      if(confirm("確定要登出並關閉視窗嗎？")) {
          liff.closeWindow();
      }
    },

    goToAdmin() {
      // 後台由於還在 GAS 裡面，這裡跳轉需包含完整的 API 網址，並加上 ?p=admin
      alert("即將為您導向至後台系統...");
      window.location.href = GAS_API_URL + "?p=admin";
    }
  }
});

app.mount('#app');
