const GAS_API_URL = "https://script.google.com/macros/s/AKfycby9csZsJaxn3X13T2UmCTT84oe4UgZA6Dk8YwLtzAJI7SLTV6TRpBxrEErWBEUZGYMy/exec";
const LIFF_ID = "2008914129-GhF8Lno6";

const { createApp } = Vue;

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

createApp({
  data() {
    return {
      loading: false,
      currentUser: null,
      loginForm: { email: '', password: '' },
      currentTab: 'inbound',
      products: [],
      searchQuery: '',
      
      inboundBatch: { poNumber: '', vendor: '', items: [] },
      inboundItem: { isNew: false, selectedProduct: null, sku: '', name: '', category: '', qty: '', cost: '' },

      rawOrders: [],
      showReceiptModal: false,
      receiptData: {}
    }
  },
  computed: {
    filteredProducts() {
      if (!this.searchQuery) return this.products;
      const q = this.searchQuery.toLowerCase();
      return this.products.filter(p => p.name.toLowerCase().includes(q) || String(p.sku).toLowerCase().includes(q));
    },
    canAddToBatch() {
      if (this.inboundItem.isNew) {
        return this.inboundItem.sku && this.inboundItem.name && this.inboundItem.qty > 0;
      } else {
        return this.inboundItem.selectedProduct && this.inboundItem.qty > 0;
      }
    },
    groupedOrders() {
      const groups = {};
      const source = this.rawOrders || [];
      
      source.forEach(row => {
        if (!groups[row.id]) {
          groups[row.id] = {
            id: row.id,
            date: row.date,
            simpleDate: row.simpleDate,
            customer: row.customer,
            items: [],
            note: row.note,
            coupon: row.coupon,
            totalAmount: 0
          };
        }
        
        const isGift = row.note && row.note.includes("(兌換贈品)");
        
        const displayItem = { ...row };
        if (isGift) {
           displayItem.total = 0;
           displayItem.isGift = true;
        }

        groups[row.id].items.push(displayItem);
        
        if (!isGift) {
          groups[row.id].totalAmount += row.total;
        }
      });
      return Object.values(groups);
    }
  },
  methods: {
    async checkLoginStatus() {
      const stored = localStorage.getItem('admin_user');
      if (stored) {
        try { 
            this.currentUser = JSON.parse(stored); 
            this.loadProducts(); 
        } catch(e) { 
            localStorage.removeItem('admin_user'); 
        }
      } else {
          // 若無 localStorage，檢查是否是透過 LIFF 登入後重導回來
          try {
              await liff.init({ liffId: LIFF_ID });
              if (liff.isLoggedIn()) {
                  this.loading = true;
                  const profile = await liff.getProfile();
                  const result = await callApi('verifyUser', { lineId: profile.userId });
                  if (result.success) {
                      this.currentUser = result.user;
                      localStorage.setItem('admin_user', JSON.stringify(result.user));
                      this.loadProducts();
                  } else {
                      alert("您登入的 LINE 帳號無權限進入系統。");
                      liff.logout();
                  }
                  this.loading = false;
              }
          } catch (e) {
              console.error("LIFF init error", e);
          }
      }
    },
    async login() {
      this.loading = true;
      const res = await callApi('verifyAdminLogin', { email: this.loginForm.email, password: this.loginForm.password });
      this.loading = false;
      
      if (res.success) { 
          this.currentUser = res.user; 
          localStorage.setItem('admin_user', JSON.stringify(res.user)); 
          this.loadProducts(); 
      } else {
          alert(res.message);
      }
    },
    lineLogin() {
      if (!liff.isLoggedIn()) {
         liff.login({ redirectUri: window.location.href });
      }
    },
    logout() {
      if(confirm("確定登出？")) { 
          this.currentUser = null; 
          localStorage.removeItem('admin_user'); 
          if(liff.isLoggedIn()) liff.logout();
      }
    },
    goToPos() {
      window.location.href = 'index.html';
    },

    async loadProducts() {
      this.loading = true;
      const res = await callApi('getProducts');
      if (res.success) {
          this.products = res.data.map(p => ({...p, actualStock: ''}));
      }
      this.loading = false;
    },
    fillProductInfo() {
      if (this.inboundItem.selectedProduct) {
        this.inboundItem.sku = this.inboundItem.selectedProduct.sku;
        this.inboundItem.name = this.inboundItem.selectedProduct.name;
      }
    },
    addToBatch() {
      this.inboundBatch.items.push({
        sku: this.inboundItem.sku,
        name: this.inboundItem.name,
        category: this.inboundItem.category,
        qty: this.inboundItem.qty,
        cost: this.inboundItem.cost,
        isNew: this.inboundItem.isNew
      });
      this.inboundItem.qty = '';
      this.inboundItem.cost = '';
      if (this.inboundItem.isNew) {
         this.inboundItem.sku = ''; this.inboundItem.name = '';
      } else {
         this.inboundItem.selectedProduct = null;
      }
    },
    async submitBatchInbound() {
      if (!confirm(`確定送出 ${this.inboundBatch.items.length} 筆進貨？`)) return;
      
      const payload = {
        poNumber: this.inboundBatch.poNumber,
        vendor: this.inboundBatch.vendor,
        items: JSON.parse(JSON.stringify(this.inboundBatch.items)),
        operator: this.currentUser.name,
        note: '批次進貨'
      };
      
      this.loading = true;
      const res = await callApi('adminInbound', payload);
      this.loading = false;
      if (res.success) {
          alert(res.message);
          this.inboundBatch.items = []; 
          this.inboundBatch.poNumber = '';
          this.loadProducts(); 
      } else {
          alert(res.message || "錯誤");
      }
    },

    getDiff(p) { 
      if (p.stock === 999999999) return '-';
      return p.actualStock === '' ? '-' : p.actualStock - p.stock; 
    },
    getDiffClass(p) { 
      const d = this.getDiff(p);
      return d === '-' ? '' : (d < 0 ? 'text-danger' : 'text-success');
    },
    async submitStocktake() {
      const items = this.products.filter(p => p.actualStock !== '').map(p => ({
        sku: p.sku, name: p.name, systemStock: p.stock, actualStock: p.actualStock, diff: p.actualStock - p.stock
      }));
      if (items.length === 0) return alert("未輸入數據");
      if (!confirm("確定修正庫存？")) return;
      
      this.loading = true;
      const res = await callApi('adminStocktake', { items, operator: this.currentUser.name, note: '盤點修正' });
      this.loading = false;
      if (res.success) {
          alert(res.message); 
          this.loadProducts();
      } else {
          alert(res.message);
      }
    },

    async loadOrders() {
      this.currentTab = 'orders';
      this.loading = true;
      const res = await callApi('adminGetOrders');
      this.loading = false;
      
      if (res.success) {
          this.rawOrders = res.data || [];
      } else {
          this.rawOrders = []; 
          alert("讀取訂單失敗，請檢查後台日誌");
      }
    },
    async voidOrder(id) {
      if (!confirm(`作廢單號 ${id}？\n將刪除紀錄並回補庫存。`)) return;
      this.loading = true;
      const res = await callApi('adminVoidOrder', { orderId: id });
      this.loading = false;
      if (res.success) {
          alert(res.message); 
          this.loadOrders();
      } else {
          alert(res.message);
      }
    },

    openReceiptModal(order) {
      let rawEquip = 0; 
      let rawMat = 0;   
      let totalDiscount = 0; 
      
      let equipItems = []; 
      let matItems = [];   

      const dateStr = order.date ? order.date.split(' ')[0].substring(5) : "";

      order.items.forEach(item => {
        if ((item.note && item.note.includes("(兌換贈品)")) || item.isGift) {
           return; 
        }

        if (item.sku === 'SYSTEM_DISC' || item.sku === 'DISCOUNT') {
           totalDiscount += Math.abs(item.total);
        } else {
           const qty = item.qty || 1;
           const unitPrice = item.price || Math.round(Math.abs(item.total) / qty);
           const lineTotal = item.total; 
           
           const infoString = `${item.name} ${unitPrice}元x${qty}`;
           
           const isMat = item.name.includes("耗材") || item.name.includes("線材") || 
                         item.name.includes("帆布") || item.name.includes("紙") || 
                         item.name.includes("燈") || item.category === '耗材';
                         
           const isEquip = item.name.includes("設備") || item.name.includes("機") || 
                           item.name.includes("雷切") || item.name.includes("雷雕") || 
                           item.name.includes("縫紉") || item.name.includes("刺繡");

           if (isMat) {
             rawMat += lineTotal;
             matItems.push(infoString);
           } else if (isEquip) {
             rawEquip += lineTotal;
             equipItems.push(infoString);
           } else {
             rawMat += lineTotal; 
             matItems.push(infoString);
           }
        }
      });

      let netEquip = rawEquip;
      let netMat = rawMat;
      let usedDiscOnEquip = 0;
      let usedDiscOnMat = 0;

      if (totalDiscount > 0) {
         if (netEquip >= totalDiscount) {
            usedDiscOnEquip = totalDiscount;
            netEquip -= totalDiscount;
            totalDiscount = 0;
         } else {
            usedDiscOnEquip = netEquip;
            const remainingDisc = totalDiscount - netEquip;
            netEquip = 0; 
            
            usedDiscOnMat = remainingDisc;
            netMat -= remainingDisc;
            if (netMat < 0) netMat = 0;
         }
      }

      let note003 = "";
      let note004 = "";

      const getDiscountName = () => {
         let names = [];
         if (order.note && order.note.includes("[學生證]")) names.push("學生證折扣");
         if (order.coupon) names.push(`折價券折扣(${order.coupon})`);
         
         return names.length > 0 ? names.join(" & ") : "折扣";
      };

      const discLabel = getDiscountName();

      if (equipItems.length > 0) {
         note003 = `${dateStr} ${equipItems.join("，")}`;
         if (usedDiscOnEquip > 0) {
            note003 += `，${discLabel}：-${usedDiscOnEquip}`;
         }
      }

      if (matItems.length > 0) {
         note004 = `${dateStr} ${matItems.join("，")}`;
         if (usedDiscOnMat > 0) {
            note004 += `，${discLabel}：-${usedDiscOnMat}`;
         }
      }

      this.receiptData = {
        id: order.id,
        customer: order.customer,
        fee003: netEquip,
        note003: note003,
        fee004: netMat,
        note004: note004
      };
      this.showReceiptModal = true;
    },
    copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
      });
    }
  },
  mounted() { this.checkLoginStatus(); }
}).mount('#app');
