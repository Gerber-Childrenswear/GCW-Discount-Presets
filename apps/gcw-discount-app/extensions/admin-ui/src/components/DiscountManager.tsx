import { useState, useEffect } from 'react';
import { PreviewDiscountModal }
from './PreviewDiscountModal';
import type { Discount as PreviewDiscount } from
'../types';

interface Discount {
  id: string;
  name: string;
  type:
'percentage' | 'free_shipping' | 'fixed_amount';
  value: number;
  paused: boolean;
  status?: 'active' | 'inactive' | 'scheduled';
  cart_message: string;
  checkout_message: string;
  included_tags: string;
 
excluded_tags: string;
  start_date: string;
  end_date: string | null;
  activated:
boolean;
  shopify_discount_id: string | null;
}

interface DiscountFormData {
 
id: string;
  name: string;
  type: 'percentage' | 'free_shipping' |
'fixed_amount';
  value: number;
  included_tags: string;
  excluded_tags: string;
 
start_date: string;
  end_date: string;
  cart_message: string;
  checkout_message:
string;
}

export function DiscountManager() {
...
...
  const [discounts, setDiscounts] =
useState<Discount[]>([]);
  const [loading, setLoading] = useState(true);
 
const [error, setError] = useState<string | null>(null);
  const [editingId,
setEditingId] = useState<string | null>(null);
  const [formData, setFormData] =
useState<DiscountFormData | null>(null);
  const [previewDiscount, setPreviewDiscount]
= useState<PreviewDiscount | null>(null);
  const [activeTab, setActiveTab] =
useState<'active' | 'inactive' | 'scheduled'>('active');

  const buildPreviewDiscount =
(discount: Discount): PreviewDiscount => {
    const valueLabel = discount.type ===
'percentage'
      ? `${discount.value}%`
      : `$${discount.value}`;

   
return {
      id: discount.id,
      name: discount.name,
      description:
discount.checkout_message || discount.cart_message || undefined,
      type:
discount.type === 'free_shipping' ? 'free-shipping' : 'percentage',
...
...
      value:
valueLabel,
      applicableTo: 'all',
      status: discount.paused ? 'paused' :
'active',
      createdAt: new Date().toISOString(),
      updatedAt: new
Date().toISOString(),
      metadata: {
        included_tags: discount.included_tags,
      
 excluded_tags: discount.excluded_tags,
        start_date:
discount.start_date,
        end_date: discount.end_date,
      },
    };
  };

  useEffect(() =>
{
    loadDiscounts();
  }, []);

  const loadDiscounts = async () => {
    try
{
      setLoading(true);
      const response = await fetch('/api/discounts');
 
    if (!response.ok) throw new Error('Failed to load discounts');
      const
result = await response.json();
      if (result && typeof result === 'object'
&& 'success' in result && result.success === false) {
        throw new
Error(result.error || 'Failed to load discounts');
      }
      const payload =
...
...
Array.isArray(result) ? result : (result?.data ?? result);
      if
(!Array.isArray(payload)) {
        throw new Error('Unexpected discount response format');
      }

     setDiscounts(payload);
      setError(null);
    } catch (err) {
     
setError(err instanceof Error ? err.message : 'Failed to load discounts');
    }
finally {
      setLoading(false);
    }
  };

  const handleEdit = (discount:
Discount) => {
    setEditingId(discount.id);
    setFormData({
      id:
discount.id,
      name: discount.name,
      type: discount.type,
      value:
discount.value,
      included_tags: discount.included_tags || '',
      excluded_tags:
discount.excluded_tags || '',
      start_date: discount.start_date || '',
     
end_date: discount.end_date || '',
      cart_message: discount.cart_message ||
'',
      checkout_message: discount.checkout_message || '',
    });
  };

 
const handleSave = async () => {
    if (!formData) return;
...
...
    try {
      const
response = await fetch(`/api/discount/save`, {
        method: 'POST',
       
headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
id: formData.id, settings: formData }),
      });
      if (!response.ok) throw
new Error('Failed to save discount');
      setEditingId(null);
     
setFormData(null);
      await loadDiscounts();
    } catch (err) {
      setError(err
instanceof Error ? err.message : 'Failed to save discount');
    }
  };

  const
handleActivate = async (discountId: string) => {
    try {
      const response =
await fetch(`/api/discount/${discountId}/activate`, {
        method: 'POST',
    
 });
      if (!response.ok) throw new Error('Failed to activate discount');
  
   const result = await response.json();
      alert(`Discount activated!
Shopify ID: ${result.shopify_discount_id || 'pending'}`);
      await
loadDiscounts();
...
...
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message :
'Failed to activate'}`);
    }
  };

  const handlePreview = (discount:
Discount) => {
    setPreviewDiscount(buildPreviewDiscount(discount));
  };

  if
(loading) {
    return (
      <div style={{ padding: '20px', textAlign: 'center'
}}>
        <p>Loading discounts...</p>
      </div>
    );
  }

  const
activeDiscounts = discounts.filter(d => !d.paused && d.status !== 'scheduled');
  const inactiveDiscounts =
discounts.filter(d => d.paused);
  const scheduledDiscounts = discounts.filter(d => d.status === 'scheduled');

  return (
    <div style={{ padding: '24px', maxWidth:
'1400px', margin: '0 auto', backgroundColor: '#f9fafb', minHeight: '100vh' }}>
 
    {previewDiscount && (
        <PreviewDiscountModal
         
discount={previewDiscount}
          onClose={() => setPreviewDiscount(null)}
        />
    
 )}
      {/* Header */}
      ...
...
      <div style={{ marginBottom: '32px' }}>
       
<h1 style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '8px', color:
'#1f2937' }}>Discount Manager</h1>
        <p style={{ color: '#6b7280', fontSize:
'15px' }}>Create and manage promotional discounts for your store</p>
     
</div>

      {/* Error Alert */}
      {error && (
        <div
          style={{

           padding: '12px 16px',
            backgroundColor: '#fee2e2',
      
     border: '1px solid #fca5a5',
            borderRadius: '8px',
           
color: '#991b1b',
            marginBottom: '24px',
            fontSize:
'14px',
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/*
Edit Form */}
      {editingId && formData && (
        <div style={{
marginBottom: '32px' }}>
          ...
...
          <DiscountForm
            formData={formData}
        
   onChange={(field, value) =>
              setFormData({ ...formData,
[field]: value })
            }
            onSave={handleSave}
           
onCancel={() => {
              setEditingId(null);
              setFormData(null);
      
     }}
          />
        </div>
      )}

      {/* Stats Overview */}
    
 <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,
minmax(200px, 1fr))', gap: '16px', marginBottom: '32px' }}>
        <StatCard
label="Total Discounts" value={discounts.length.toString()} />
        <StatCard
label="Active" value={activeDiscounts.length.toString()} color="#10b981" />
       
<StatCard label="Paused" value={inactiveDiscounts.length.toString()} color="#f59e0b"
/>
        <StatCard label="Scheduled" value={scheduledDiscounts.length.toString()} color="#f59e0b" />
      </div>

      {/* Tabs */}
      <div style={{ marginBottom: '24px',
      ...
...
display: 'flex', gap: '16px', borderBottom: '2px solid #e5e7eb', paddingBottom:
'16px' }}>
        <button
          onClick={() => setActiveTab('active')}
      
   style={{
            padding: '12px 20px',
            fontSize: '15px',
   
        fontWeight: activeTab === 'active' ? '600' : '400',
           
background: 'transparent',
            border: 'none',
            borderBottom:
activeTab === 'active' ? '3px solid #667eea' : 'none',
            color: activeTab
=== 'active' ? '#667eea' : '#6b7280',
            cursor: 'pointer',
           
marginBottom: '-18px',
          }}
        >
          Active Discounts
({activeDiscounts.length})
        </button>
        <button
          onClick={() =>
setActiveTab('inactive')}
          style={{
            padding: '12px 20px',
   
        fontSize: '15px',
            ...
...
            fontWeight: activeTab === 'inactive' ?
'600' : '400',
            background: 'transparent',
            border: 'none',

           borderBottom: activeTab === 'inactive' ? '3px solid #667eea' :
'none',
            color: activeTab === 'inactive' ? '#667eea' : '#6b7280',
        
   cursor: 'pointer',
            marginBottom: '-18px',
          }}
       
>
          Paused ({inactiveDiscounts.length})
        </button>
        <button
          onClick={() => setActiveTab('scheduled')}
          style={{
            padding: '12px 20px',
            fontSize: '15px',
            fontWeight: activeTab === 'scheduled' ? '600' : '400',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'scheduled' ? '3px solid #667eea' : 'none',
            color: activeTab === 'scheduled' ? '#667eea' : '#6b7280',
            cursor: 'pointer',
            marginBottom: '-18px',
          }}
        >
          Scheduled ({scheduledDiscounts.length})
        </button>
      </div>

 
    {/* Discount Grid */}
      {activeTab === 'active' && (
        <>
       
  {activeDiscounts.length > 0 ? (
            <div
              style={{
     
          display: 'grid',
                gridTemplateColumns:
'repeat(auto-fill, minmax(340px, 1fr))',
                gap: '20px',
              }}
        
   >
              {activeDiscounts.map((discount) => (
               
<DiscountCard
                  key={discount.id}
                  ...
...
discount={discount}
                  onEdit={() => handleEdit(discount)}
                 
onPreview={() => handlePreview(discount)}
                  onActivate={() =>
handleActivate(discount.id)}
                />
              ))}
            </div>
    
     ) : (
            <div style={{ textAlign: 'center', padding: '40px 20px',
color: '#6b7280' }}>
              <p style={{ fontSize: '16px', marginBottom:
'8px' }}>No active discounts</p>
              <p style={{ fontSize: '14px'
}}>Create a new discount to get started</p>
            </div>
          )}
       
</>
      )}

      {activeTab === 'inactive' && (
        <>
         
{inactiveDiscounts.length > 0 ? (
            <div
              style={{
              
 display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill,
minmax(340px, 1fr))',
                gap: '20px',
              }}
            >
   
          {inactiveDiscounts.map((discount) => (
           ...
...
                <DiscountCard

                 key={discount.id}
                  discount={discount}
      
           onEdit={() => handleEdit(discount)}
                  onPreview={()
=> handlePreview(discount)}
                  onActivate={() =>
handleActivate(discount.id)}
                />
              ))}
            </div>
          )
: (
            <div style={{ textAlign: 'center', padding: '40px 20px', color:
'#6b7280' }}>
              <p style={{ fontSize: '16px', marginBottom: '8px'
}}>No paused discounts</p>
              <p style={{ fontSize: '14px' }}>All your
discounts are active!</p>
            </div>
          )}
        </>
      )}

      {activeTab === 'scheduled' && (
        <>
          {scheduledDiscounts.length > 0 ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                gap: '20px',
              }}
            >
              {scheduledDiscounts.map((discount) => (
                <DiscountCard
                  key={discount.id}
                  discount={discount}
                  onEdit={() => handleEdit(discount)}
                  onPreview={() => handlePreview(discount)}
                  onActivate={() => handleActivate(discount.id)}
                />
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: '#6b7280' }}>
              <p style={{ fontSize: '16px', marginBottom: '8px' }}>No scheduled discounts</p>
              <p style={{ fontSize: '14px' }}>Create and schedule a new function discount to see it here</p>
            </div>
          )}
        </>
      )}

   </div>
  );
}

function StatCard({ label, value, color = '#667eea' }: {
label: string; value: string; color?: string }) {
  return (
    <div
     
style={{
        background: 'white',
        border: '1px solid #e5e7eb',
        ...
...
borderRadius: '8px',
        padding: '20px',
        boxShadow: '0 1px 2px
rgba(0,0,0,0.05)',
      }}
    >
      <p style={{ color: '#6b7280', fontSize: '13px',
fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
       
{label}
      </p>
      <p style={{ fontSize: '32px', fontWeight: 'bold', color:
color }}>{value}</p>
    </div>
  );
}

function DiscountCard({
  discount,
 
onEdit,
  onPreview,
  onActivate,
}: {
  discount: Discount;
  onEdit: () =>
void;
  onPreview: () => void;
  onActivate: () => void;
}) {
  return (
    <div
  
   style={{
        background: 'white',
        border: '1px solid #e5e7eb',
 
      borderRadius: '8px',
        ...
...
        padding: '20px',
        boxShadow: '0 1px
2px rgba(0,0,0,0.05)',
        transition: 'box-shadow 0.2s ease',
      }}
     
onMouseEnter={(e) => (e.currentTarget.style.boxShadow = '0 4px 6px
rgba(0,0,0,0.1)')}
      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = '0 1px 2px
rgba(0,0,0,0.05)')}
    >
      {/* Header */}
      <div style={{ marginBottom:
'16px', display: 'flex', justifyContent: 'space-between', alignItems: 'start'
}}>
        <h3 style={{ fontSize: '17px', fontWeight: '700', color: '#1f2937',
margin: 0 }}>{discount.name}</h3>
        <span
          style={{
           
padding: '4px 10px',
...
...
            borderRadius: '6px',
            fontSize:
'12px',
            fontWeight: '700',
            backgroundColor: discount.paused ?
'#fef3c7' : discount.status === 'scheduled' ? '#dbeafe' : '#d1fae5',
            color: discount.paused ? '#92400e' : discount.status === 'scheduled' ? '#1e40af' : '#065f46',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
 
        }}
        >
          {discount.paused ? 'Paused' : discount.status === 'scheduled' ? 'Scheduled' : 'Active'}
       
</span>
      </div>

      {/* Main Info */}
      <div style={{ marginBottom:
'16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr
1fr', gap: '12px', marginBottom: '12px' }}>
          <div>
            <p style={{
fontSize: '12px', color: '#6b7280', fontWeight: '600', margin: '0 0 4px 0',
textTransform: 'uppercase' }}>Discount</p>
            <p style={{ fontSize: '18px',
            ...
...
fontWeight: '700', color: '#667eea', margin: 0 }}>{discount.value}%</p>
       
  </div>
          <div>
            <p style={{ fontSize: '12px', color:
'#6b7280', fontWeight: '600', margin: '0 0 4px 0', textTransform: 'uppercase'
}}>Type</p>
            <p style={{ fontSize: '14px', color: '#374151', margin: 0,
fontWeight: '500' }}>{discount.type.replace('_', ' ')}</p>
          </div>
       
</div>
        {discount.included_tags && (
          <p style={{ fontSize:
'13px', color: '#6b7280', margin: '8px 0 0 0' }}>
            <span style={{
fontWeight: '600' }}>Tags:</span> {discount.included_tags}
          </p>
        )}
  
     {discount.start_date && (
          <p style={{ fontSize: '13px', color:
          ...
...
'#6b7280', margin: '8px 0 0 0' }}>
            <span style={{ fontWeight: '600'
}}>Starts:</span> {new Date(discount.start_date).toLocaleDateString()}
         
</p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display:
'flex', gap: '8px', flexWrap: 'wrap', paddingTop: '16px', borderTop: '1px solid
#f3f4f6' }}>
        <button
          onClick={onEdit}
          style={{
    
       flex: '1',
            minWidth: '80px',
            padding: '8px
12px',
            fontSize: '13px',
            background: '#667eea',
           
color: 'white',
            border: 'none',
            borderRadius: '6px',
    
       cursor: 'pointer',
            fontWeight: '600',
           
transition: 'background 0.2s ease',
          }}
          onMouseEnter={(e) =>
...
...
(e.currentTarget.style.background = '#5568d3')}
          onMouseLeave={(e) =>
(e.currentTarget.style.background = '#667eea')}
        >
          Edit
        </button>

       <button
          onClick={onPreview}
          style={{
           
flex: '1',
            minWidth: '80px',
            padding: '8px 12px',
         
  fontSize: '13px',
            background: '#f3f4f6',
            color:
'#374151',
            border: 'none',
            borderRadius: '6px',
           
cursor: 'pointer',
            fontWeight: '600',
            transition:
'background 0.2s ease',
          }}
          onMouseEnter={(e) =>
(e.currentTarget.style.background = '#e5e7eb')}
          onMouseLeave={(e) =>
(e.currentTarget.style.background = '#f3f4f6')}
        >
          Preview
        </button>
      
 {!discount.activated && (
          <button
            onClick={onActivate}
 
          style={{
          ...
...
              flex: '1',
              minWidth: '80px',
   
          padding: '8px 12px',
              fontSize: '13px',
             
background: '#10b981',
              color: 'white',
              border:
'none',
              borderRadius: '6px',
              cursor: 'pointer',
           
  fontWeight: '600',
              transition: 'background 0.2s ease',
        
   }}
            onMouseEnter={(e) => (e.currentTarget.style.background =
'#059669')}
            onMouseLeave={(e) => (e.currentTarget.style.background =
'#10b981')}
          >
            Activate
          </button>
        )}
       
{discount.activated && (
          <div
            style={{
             
flex: '1',
              minWidth: '80px',
              padding: '8px 12px',
      
       fontSize: '13px',
              color: '#10b981',
             
fontWeight: '600',
              display: 'flex',
              alignItems: 'center',
              ...
...
           justifyContent: 'center',
              background: '#ecfdf5',
     
        borderRadius: '6px',
            }}
          >
            ✓ Active
  
       </div>
        )}
      </div>
    </div>
  );
}

function
DiscountForm({
  formData,
  onChange,
  onSave,
  onCancel,
}: {
  formData:
DiscountFormData;
  onChange: (field: string, value: string | number) => void;
  onSave: () =>
void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
       
background: 'white',
        border: '1px solid #e5e7eb',
        borderRadius:
'8px',
        padding: '20px',
        marginBottom: '20px',
      }}
    >
     
<h2 style={{ marginBottom: '16px', fontSize: '18px', fontWeight: '600' }}>Edit
Discount</h2>
      ...
...
      <div style={{ display: 'grid', gridTemplateColumns: '1fr
1fr', gap: '16px', marginBottom: '16px' }}>
        <div>
          <label
style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: '600'
}}>
            Name
          </label>
          <input
            type="text"
  
         value={formData.name}
            onChange={(e) => onChange('name',
e.target.value)}
            style={{ width: '100%', padding: '8px', border: '1px
solid #d1d5db', borderRadius: '4px' }}
          />
        </div>

       
<div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize:
'13px', fontWeight: '600' }}>
            Value (%)
          </label>
         
<input
            type="number"
            value={formData.value}
           
onChange={(e) => onChange('value', parseFloat(e.target.value))}
...
...
style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius:
'4px' }}
          />
        </div>

        <div>
          <label style={{
display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: '600' }}>
      
     Included Tags (comma separated)
          </label>
          <input
      
     type="text"
            placeholder="e.g., discount,sale"
           
value={formData.included_tags}
            onChange={(e) =>
onChange('included_tags', e.target.value)}
            style={{ width: '100%', padding: '8px', border:
'1px solid #d1d5db', borderRadius: '4px' }}
          />
        </div>

       
<div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize:
'13px', fontWeight: '600' }}>
            Excluded Tags (comma separated)
     
    </label>
          <input
          ...
...
            type="text"
           
placeholder="e.g., no-discount"
            value={formData.excluded_tags}
           
onChange={(e) => onChange('excluded_tags', e.target.value)}
            style={{
width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
  
       />
        </div>

        <div>
          <label style={{ display:
'block', marginBottom: '4px', fontSize: '13px', fontWeight: '600' }}>
           
Start Date/Time
          </label>
          <input
           
type="datetime-local"
            value={formData.start_date}
            onChange={(e) =>
onChange('start_date', e.target.value)}
            style={{ width: '100%', padding:
'8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
          />
       
</div>

        <div>
          <label style={{ display: 'block', marginBottom:
          ...
...
'4px', fontSize: '13px', fontWeight: '600' }}>
            End Date/Time
         
</label>
          <input
            type="datetime-local"
           
value={formData.end_date}
            onChange={(e) => onChange('end_date',
e.target.value)}
            style={{ width: '100%', padding: '8px', border: '1px solid
#d1d5db', borderRadius: '4px' }}
          />
        </div>

        <div
        
 style={{
            gridColumn: '1 / -1',
          }}
        >
         
<label style={{ display: 'block', marginBottom: '4px', fontSize: '13px',
fontWeight: '600' }}>
            Cart Message
          </label>
          <input
      
     type="text"
            value={formData.cart_message}
           
onChange={(e) => onChange('cart_message', e.target.value)}
            style={{ width:
...
...
'100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
     
    />
        </div>

        <div
          style={{
            gridColumn:
'1 / -1',
          }}
        >
          <label style={{ display: 'block',
marginBottom: '4px', fontSize: '13px', fontWeight: '600' }}>
            Checkout
Message
          </label>
          <input
            type="text"
           
value={formData.checkout_message}
            onChange={(e) =>
onChange('checkout_message', e.target.value)}
            style={{ width: '100%', padding: '8px',
border: '1px solid #d1d5db', borderRadius: '4px' }}
          />
        </div>

     </div>

      <div style={{ display: 'flex', gap: '12px', justifyContent:
'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            ...
...
          padding: '8px 16px',
            background: '#f0f0f0',
           
color: '#333',
            border: 'none',
            borderRadius: '4px',
     
      cursor: 'pointer',
            fontWeight: '600',
          }}
        >

         Cancel
        </button>
        <button
          onClick={onSave}
  
       style={{
            padding: '8px 16px',
            background:
'#667eea',
            color: 'white',
            border: 'none',
           
borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: '600',
    
     }}
        >
          Save Changes
        </button>
      </div>
   
</div>
  );
}
