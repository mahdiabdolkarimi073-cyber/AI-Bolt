"use client";

import React, { useState } from "react";
import {
  ShoppingBag,
  Search,
  Menu,
  X,
  Heart,
  Star,
  ShieldCheck,
  Truck,
  Headphones,
  ArrowRight,
  ChevronLeft,
  Flame,
  Tag,
  User,
  SlidersHorizontal
} from "lucide-react";

export default function Home() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("همه");
  const [cartCount, setCartCount] = useState(2);
  const [notification, setNotification] = useState<string | null>(null);

  const categories = [
    { name: "همه", icon: "🌟" },
    { name: "لوازم دیجیتال", icon: "💻" },
    { name: "موبایل و گجت", icon: "📱" },
    { name: "مد و پوشاک", icon: "👕" },
    { name: "خانه و آشپزخانه", icon: "🏠" },
    { name: "ورزش و سفر", icon: "⚽" },
    { name: "لوازم آرایشی", icon: "💄" },
  ];

  const products = [
    {
      id: 1,
      title: "هدفون بی‌سیم پرو مدل ANC-900",
      category: "لوازم دیجیتال",
      price: "۴,۲50,000",
      oldPrice: "۵,۱۰۰,000",
      discount: "۱۷٪",
      rating: 4.8,
      reviews: 124,
      image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=600&q=80",
      badge: "پرفروش",
    },
    {
      id: 2,
      title: "ساعت هوشمند اولترا سری ۸",
      category: "موبایل و گجت",
      price: "۲,۸۹0,000",
      oldPrice: "۳,۵۰۰,000",
      discount: "۱۸٪",
      rating: 4.6,
      reviews: 98,
      image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=600&q=80",
      badge: "پیشنهاد ویژه",
    },
    {
      id: 3,
      title: "کفش رانینگ مردانه نایک مدل ایر مکس",
      category: "ورزش و سفر",
      price: "۳,۱50,000",
      oldPrice: "۳,۸00,000",
      discount: "۱۵٪",
      rating: 4.9,
      reviews: 210,
      image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80",
      badge: "جدید",
    },
    {
      id: 4,
      title: "دوربین عکاسی دیجیتال بدون آینه مدل Z-50",
      category: "لوازم دیجیتال",
      price: "۳۲,۵00,000",
      oldPrice: "۳۵,۰۰۰,000",
      discount: "۷٪",
      rating: 4.7,
      reviews: 45,
      image: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=600&q=80",
      badge: "تخفیف شگفت‌انگیز",
    },
    {
      id: 5,
      title: "عینک آفتابی خلبانی اصل ری‌بن",
      category: "مد و پوشاک",
      price: "۱,۶۵0,000",
      oldPrice: "۲,۱۰۰,000",
      discount: "۲۱٪",
      rating: 4.5,
      reviews: 82,
      image: "https://images.unsplash.com/photo-1572635196237-14b3f281503f?auto=format&fit=crop&w=600&q=80",
      badge: "پرفروش",
    },
    {
      id: 6,
      title: "کوله پشتی لپ‌تاپ ضد آب حرفه‌ای",
      category: "مد و پوشاک",
      price: "۱,۲50,000",
      oldPrice: "۱,۶00,000",
      discount: "۲۲٪",
      rating: 4.7,
      reviews: 156,
      image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80",
      badge: "ارسال رایگان",
    },
    {
      id: 7,
      title: "اسپیکر بلوتوثی قابل حمل باسیم و وایرلس",
      category: "لوازم دیجیتال",
      price: "۲,۳00,000",
      oldPrice: "۲,۹00,000",
      discount: "۲۰٪",
      rating: 4.8,
      reviews: 91,
      image: "https://images.unsplash.com/photo-1543512214-318c7553f230?auto=format&fit=crop&w=600&q=80",
      badge: "ویژه",
    },
    {
      id: 8,
      title: "ست ماوس و کیبورد گیمینگ RGB",
      category: "لوازم دیجیتال",
      price: "۱,۸90,000",
      oldPrice: "۲,۴00,000",
      discount: "۲۱٪",
      rating: 4.9,
      reviews: 304,
      image: "https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=600&q=80",
      badge: "پرفروش",
    },
  ];

  const filteredProducts = products.filter((product) => {
    const matchesCategory = selectedCategory === "همه" || product.category === selectedCategory;
    const matchesSearch = product.title.toLowerCase().includes(searchQuery.toLowerCase()) || product.category.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const handleAddToCart = (title: string) => {
    setCartCount((prev) => prev + 1);
    setNotification(`محصول "${title}" به سبد خرید اضافه شد.`);
    setTimeout(() => {
      setNotification(null);
    }, 3500);
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 font-sans selection:bg-rose-500 selection:text-white">
      {/* Toast Notification */}
      {notification && (
        <div className="fixed bottom-6 left-6 z-50 bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border border-slate-800 dark:border-slate-200 animate-bounce">
          <ShoppingBag className="w-5 h-5 text-rose-500" />
          <span className="text-sm font-medium">{notification}</span>
        </div>
      )}

      {/* Top Announcement Bar */}
      <div className="bg-rose-600 text-white text-xs sm:text-sm py-2 px-4 text-center font-medium flex items-center justify-center gap-2 shadow-inner">
        <Flame className="w-4 h-4 animate-pulse text-amber-300" />
        <span>جشنواره تخفیفات تابستانه: تا ۵۰٪ تخفیف روی تمامی دسته‌بندی‌ها + ارسال رایگان خریدهای بالای ۱ میلیون تومان!</span>
      </div>

      {/* Main Header */}
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between gap-4">
          
          {/* Mobile Menu Button */}
          <div className="flex items-center gap-3 lg:hidden">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="منوی موبایل"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>

          {/* Logo & Brand */}
          <div className="flex items-center gap-8">
            <a href="#" className="flex items-center gap-2.5 group">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-rose-600 to-amber-500 flex items-center justify-center text-white shadow-lg shadow-rose-500/30 group-hover:scale-105 transition-transform">
                <ShoppingBag className="w-6 h-6" />
              </div>
              <div className="flex flex-col">
                <span className="text-xl font-black tracking-tight bg-gradient-to-l from-rose-600 to-amber-600 bg-clip-text text-transparent">
                  دیجی‌استور
                </span>
                <span className="text-[10px] tracking-widest text-slate-500 dark:text-slate-400 font-semibold uppercase">
                  فروشگاه آنلاین پیشرفته
                </span>
              </div>
            </a>

            {/* Desktop Navigation */}
            <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300">
              <a href="#" className="hover:text-rose-600 dark:hover:text-rose-400 transition-colors font-semibold text-rose-600 dark:text-rose-400">صفحه اصلی</a>
              <a href="#products" className="hover:text-rose-600 dark:hover:text-rose-400 transition-colors">محصولات</a>
              <a href="#categories" className="hover:text-rose-600 dark:hover:text-rose-400 transition-colors">دسته‌بندی‌ها</a>
              <a href="#features" className="hover:text-rose-600 dark:hover:text-rose-400 transition-colors">خدمات ما</a>
              <a href="#about" className="hover:text-rose-600 dark:hover:text-rose-400 transition-colors">درباره ما</a>
            </nav>
          </div>

          {/* Search Bar (Desktop) */}
          <div className="hidden md:flex flex-1 max-w-md mx-4">
            <div className="relative w-full">
              <input
                type="text"
                placeholder="جست‌وجو در میان هزاران محصول، برند و دسته‌بندی..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-2xl pr-11 pl-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 focus:bg-white dark:focus:bg-slate-900 transition-all placeholder:text-slate-400"
              />
              <Search className="absolute right-3.5 top-3 w-5 h-5 text-slate-400" />
            </div>
          </div>

          {/* Actions: Cart & Profile */}
          <div className="flex items-center gap-3">
            <button className="relative p-2.5 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-slate-700 transition-all" aria-label="سبد خرید">
              <ShoppingBag className="w-5 h-5" />
              {cartCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 bg-rose-600 text-white text-[11px] font-bold w-5 h-5 rounded-full flex items-center justify-center shadow-md animate-pulse">
                  {cartCount}
                </span>
              )}
            </button>

            <button className="hidden sm:flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium text-sm shadow-sm hover:opacity-95 transition-all">
              <User className="w-4 h-4" />
              <span>ورود / ثبت‌نام</span>
            </button>
          </div>
        </div>

        {/* Search Bar (Mobile) */}
        <div className="md:hidden px-4 pb-3">
          <div className="relative w-full">
            <input
              type="text"
              placeholder="جست‌وجو در محصولات..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pr-10 pl-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
            />
            <Search className="absolute right-3 top-2.5 w-4 h-4 text-slate-400" />
          </div>
        </div>

        {/* Mobile Dropdown Menu */}
        {mobileMenuOpen && (
          <div className="lg:hidden absolute top-full left-0 right-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shadow-xl py-4 px-6 flex flex-col gap-4 animate-in slide-in-from-top duration-200">
            <a href="#" className="font-medium text-rose-600">صفحه اصلی</a>
            <a href="#products" onClick={() => setMobileMenuOpen(false)} className="text-slate-600 dark:text-slate-300">محصولات</a>
            <a href="#categories" onClick={() => setMobileMenuOpen(false)} className="text-slate-600 dark:text-slate-300">دسته‌بندی‌ها</a>
            <a href="#features" onClick={() => setMobileMenuOpen(false)} className="text-slate-600 dark:text-slate-300">خدمات ما</a>
            <a href="#about" onClick={() => setMobileMenuOpen(false)} className="text-slate-600 dark:text-slate-300">درباره ما</a>
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <button className="w-full py-2.5 rounded-xl bg-rose-600 text-white font-medium text-sm text-center shadow-md">
                ورود یا ثبت‌نام
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main className="flex-1">
        {/* Hero Banner Section */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white shadow-2xl p-6 sm:p-12 lg:p-16 flex flex-col lg:flex-row items-center justify-between gap-8">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(225,29,72,0.3),transparent_50%)] pointer-events-none"></div>
            
            <div className="relative z-10 max-w-xl flex flex-col items-start gap-4 sm:gap-6 text-right">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs sm:text-sm font-semibold">
                <Tag className="w-4 h-4" />
                <span>جدیدترین تکنولوژی‌های دنیا</span>
              </div>
              <h1 className="text-3xl sm:text-5xl lg:text-6xl font-black tracking-tight leading-tight">
                هوشمندتر زندگی کن، <br />
                <span className="bg-gradient-to-l from-rose-400 via-amber-300 to-rose-500 bg-clip-text text-transparent">
                  بهترین‌ها را انتخاب کن
                </span>
              </h1>
              <p className="text-slate-300 text-sm sm:text-base leading-relaxed">
                مجموعه‌ای بی‌نظیر از لوازم دیجیتال، پوشاک مدرن و گجت‌های هوشمند با تضمین اصالت کالا، ضمانت بازگشت وجه و ارسال فوق‌سریع.
              </p>
              <div className="flex flex-wrap items-center gap-4 pt-2">
                <a
                  href="#products"
                  className="flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm shadow-lg shadow-rose-600/40 transition-all hover:scale-105"
                >
                  <span>مشاهده محصولات</span>
                  <ArrowRight className="w-4 h-4 rotate-180" />
                </a>
                <a
                  href="#categories"
                  className="flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-white/10 hover:bg-white/20 text-white font-semibold text-sm backdrop-blur-md transition-all border border-white/10"
                >
                  <span>دسته‌بندی‌ها</span>
                </a>
              </div>
            </div>

            <div className="relative z-10 w-full lg:w-1/2 flex justify-center">
              <div className="relative w-full max-w-md aspect-[4/3] rounded-2xl overflow-hidden shadow-2xl border border-white/10 group">
                <img
                  src="https://images.unsplash.com/photo-1607083206869-4c7672e72a8a?auto=format&fit=crop&w=800&q=80"
                  alt="فروشگاه آنلاین"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent flex items-end p-6">
                  <div className="text-white">
                    <span className="text-xs text-rose-400 font-bold uppercase tracking-wider">تخفیف ویژه امروز</span>
                    <h3 className="text-lg font-bold">لوازم جانبی دیجیتال با تخفیف‌های شگفت‌انگیز</h3>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features / Value Proposition */}
        <section id="features" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
                <Truck className="w-6 h-6" />
              </div>
              <div>
                <h4 className="font-bold text-sm">ارسال سریع و رایگان</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">برای خریدهای بالای ۱ میلیون</p>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div>
                <h4 className="font-bold text-sm">ضمانت اصالت کالا</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">۷ روز ضمانت بازگشت وجه</p>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <Headphones className="w-6 h-6" />
              </div>
              <div>
                <h4 className="font-bold text-sm">پشتیبانی ۲۴ ساعته</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">پاسخگویی در تمام روزهای هفته</p>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <Tag className="w-6 h-6" />
              </div>
              <div>
                <h4 className="font-bold text-sm">تخفیف‌های شگفت‌انگیز</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">هر روز با پیشنهادات تازه</p>
              </div>
            </div>
          </div>
        </section>

        {/* Categories Section */}
        <section id="categories" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl sm:text-2xl font-black">دسته‌بندی‌های محبوب</h2>
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">محصولات مورد نظر خود را بر اساس دسته انتخاب کنید</p>
            </div>
          </div>

          <div className="flex items-center gap-3 overflow-x-auto pb-4 pt-1 no-scrollbar">
            {categories.map((cat, idx) => (
              <button
                key={idx}
                onClick={() => setSelectedCategory(cat.name)}
                className={`flex items-center gap-2.5 px-5 py-3 rounded-2xl text-sm font-semibold whitespace-nowrap transition-all shadow-sm shrink-0 ${
                  selectedCategory === cat.name
                    ? "bg-rose-600 text-white shadow-rose-600/30 scale-105"
                    : "bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800"
                }`}
              >
                <span className="text-base">{cat.icon}</span>
                <span>{cat.name}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Products Section */}
        <section id="products" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <div>
              <h2 className="text-xl sm:text-2xl font-black">محصولات فروشگاه</h2>
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
                نمایش {filteredProducts.length} محصول بر اساس فیلترهای انتخابی
              </p>
            </div>
            
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-500">مرتب‌سازی بر اساس:</span>
              <select className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-rose-500">
                <option>جدیدترین</option>
                <option>پرفروش‌ترین</option>
                <option>ارزان‌ترین</option>
                <option>گران‌ترین</option>
              </select>
            </div>
          </div>

          {filteredProducts.length === 0 ? (
            <div className="bg-white dark:bg-slate-900 rounded-3xl p-12 text-center border border-slate-200 dark:border-slate-800 my-8">
              <div className="w-16 h-16 bg-slate-100 dark:bg-slate-800 text-slate-400 rounded-full flex items-center justify-center mx-auto mb-4">
                <Search className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-bold">محصولی یافت نشد!</h3>
              <p className="text-sm text-slate-500 mt-1">لطفاً کلیدواژه دیگری جست‌وجو کنید یا دسته‌بندی را تغییر دهید.</p>
              <button
                onClick={() => {
                  setSelectedCategory("همه");
                  setSearchQuery("");
                }}
                className="mt-6 px-6 py-2.5 rounded-xl bg-rose-600 text-white font-medium text-sm"
              >
                نمایش همه محصولات
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {filteredProducts.map((product) => (
                <div
                  key={product.id}
                  className="group bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/80 dark:border-slate-800 overflow-hidden shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col justify-between"
                >
                  <div>
                    {/* Image & Badges */}
                    <div className="relative aspect-square overflow-hidden bg-slate-100 dark:bg-slate-800">
                      <img
                        src={product.image}
                        alt={product.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                      <div className="absolute top-3 right-3 flex flex-col gap-1">
                        <span className="bg-rose-600 text-white text-[10px] font-bold px-2.5 py-1 rounded-full shadow-md">
                          {product.badge}
                        </span>
                      </div>
                      <button className="absolute top-3 left-3 w-8 h-8 rounded-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md flex items-center justify-center text-slate-600 dark:text-slate-300 hover:text-rose-600 transition-colors shadow-sm" aria-label="افزودن به علاقه‌مندی‌ها">
                        <Heart className="w-4 h-4" />
                      </button>
                      <div className="absolute bottom-3 left-3 bg-slate-900/70 backdrop-blur-md text-white text-[10px] font-bold px-2 py-0.5 rounded-md">
                        {product.discount} تخفیف
                      </div>
                    </div>

                    {/* Content */}
                    <div className="p-5">
                      <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                        <span>{product.category}</span>
                        <div className="flex items-center gap-1 text-amber-500 font-semibold">
                          <Star className="w-3.5 h-3.5 fill-amber-500" />
                          <span>{product.rating}</span>
                          <span className="text-slate-400 font-normal">({product.reviews})</span>
                        </div>
                      </div>

                      <h3 className="font-bold text-sm sm:text-base line-clamp-2 h-11 leading-snug group-hover:text-rose-600 transition-colors">
                        {product.title}
                      </h3>
                    </div>
                  </div>

                  {/* Price & Action */}
                  <div className="p-5 pt-0 flex flex-col gap-3">
                    <div className="flex items-baseline justify-between">
                      <div className="flex flex-col">
                        <span className="text-xs text-slate-400 line-through">{product.oldPrice} تومان</span>
                        <div className="flex items-center gap-1">
                          <span className="text-lg font-black text-rose-600 dark:text-rose-400">{product.price}</span>
                          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">تومان</span>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleAddToCart(product.title)}
                      className="w-full py-3 rounded-2xl bg-slate-900 hover:bg-rose-600 text-white dark:bg-slate-800 dark:hover:bg-rose-600 text-xs font-bold transition-all duration-200 flex items-center justify-center gap-2 shadow-sm"
                    >
                      <ShoppingBag className="w-4 h-4" />
                      <span>افزودن به سبد خرید</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Promotional Banner */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="rounded-3xl bg-gradient-to-l from-amber-500 via-rose-600 to-indigo-900 text-white p-8 sm:p-12 shadow-2xl relative overflow-hidden flex flex-col md:flex-row items-center justify-between gap-8">
            <div className="absolute -left-20 -bottom-20 w-80 h-80 bg-white/10 rounded-full blur-3xl pointer-events-none"></div>
            
            <div className="max-w-lg text-right z-10">
              <span className="bg-white/20 text-white text-xs font-bold px-3.5 py-1.5 rounded-full uppercase tracking-wider">پیشنهاد محدود زمان</span>
              <h2 className="text-2xl sm:text-4xl font-black mt-4 leading-tight">تخفیف ویژه آخر فصل روی تمامی لوازم خانگی و دیجیتال</h2>
              <p className="text-white/90 text-sm mt-3 leading-relaxed">همین حالا ثبت‌نام کنید و از کد تخفیف ۵۰ هزار تومانی خرید اول بهره‌مند شوید.</p>
            </div>

            <div className="z-10 flex flex-col sm:flex-row gap-3 w-full md:w-auto">
              <input
                type="email"
                placeholder="ایمیل خود را وارد کنید..."
                className="bg-white/10 border border-white/30 rounded-2xl px-4 py-3.5 text-sm text-white placeholder:text-white/70 focus:outline-none focus:ring-2 focus:ring-white"
              />
              <button className="bg-white text-slate-900 font-bold px-6 py-3.5 rounded-2xl hover:bg-slate-100 transition-all text-sm shadow-lg whitespace-nowrap">
                عضویت در خبرنامه
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer id="about" className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 pt-16 pb-12 mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-10 mb-12">
            
            {/* Col 1: About */}
            <div className="lg:col-span-2 flex flex-col gap-4 text-right">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-rose-600 to-amber-500 flex items-center justify-center text-white shadow-md">
                  <ShoppingBag className="w-5 h-5" />
                </div>
                <span className="text-lg font-black bg-gradient-to-l from-rose-600 to-amber-600 bg-clip-text text-transparent">
                  دیجی‌استور
                </span>
              </div>
              <p className="text-slate-500 dark:text-slate-400 text-sm leading-relaxed max-w-sm">
                دیجی‌استور مرجع تخصصی نقد و بررسی و فروش اینترنتی کالاهای دیجیتال، مد و پوشاک و لوازم خانه در ایران است. با ما تجربه‌ای امن و لذت‌بخش از خرید آنلاین داشته باشید.
              </p>
              <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400 font-medium mt-2">
                <span>تلفن پشتیبانی: ۰۲۱-۱۲۳۴۵۶۷۸</span>
              </div>
            </div>

            {/* Col 2: Links */}
            <div className="flex flex-col gap-3 text-right">
              <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100 uppercase tracking-wider">خدمات مشتریان</h4>
              <a href="#" className="text-sm text-slate-500 dark:text-slate-400 hover:text-rose-600 transition-colors">پاسخ به پرسش‌های متداول</a>
              <a href="#" className="text-sm text-slate-500 dark:text-slate-400 hover:text-rose-600 transition-colors">رویه‌های بازگرداندن کالا</a>
              <a href="#" className="text-sm text-slate-500 dark:text-slate-400 hover:text-rose-600 transition-colors">شرایط استفاده</a>
              <a href="#" className="text-sm text-slate-500 dark:text-slate-400 hover:text-rose-600 transition-colors">حریم خصوصی</a>
            </div>

            {/* Col 3: Categories */}
            <div className="flex flex-col gap-3 text-right">
              <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100 uppercase tracking-wider">دسته‌بندی‌های اصلی</h4>
              <a href="#" className="text-sm text-slate-500 dark:text-slate-400 hover:text-rose-600 transition-colors">لوازم دیجیتال و هوشمند</a>
              <a href="#" className="text-sm text-slate-500 dark:text-slate-400 hover:text-rose-600 transition-colors">موبایل و تبلت</a>
              <a href="#" className="text-sm text-slate-500 dark:text-slate-400 hover:text-rose-600 transition-colors">مد و پوشاک روز</a>
              <a href="#" className="text-sm text-slate-500 dark:text-slate-400 hover:text-rose-600 transition-colors">لوازم خانه و آشپزخانه</a>
            </div>

            {/* Col 4: Trust */}
            <div className="flex flex-col gap-3 text-right">
              <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100 uppercase tracking-wider">نماد اعتماد و مجوزها</h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                با اطمینان خاطر خرید کنید. دارای نماد اعتماد الکترونیکی دو ستاره و ضمانت پرداخت امن.
              </p>
              <div className="flex gap-2 mt-2">
                <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-400">
                  نماد اعتماد
                </div>
                <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-400">
                  ساماندهی
                </div>
              </div>
            </div>

          </div>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400 text-center sm:text-right">
            <p>کلیه حقوق مادی و معنوی این وب‌سایت متعلق به فروشگاه «دیجی‌استور» می‌باشد.</p>
            <p>طراحی و توسعه حرفه‌ای با Next.js و Tailwind CSS</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
