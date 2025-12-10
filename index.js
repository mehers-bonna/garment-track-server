require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

const port = process.env.PORT || 3000
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()


// middleware
app.use(express.json())

app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
)


// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uftqhoa.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});


async function run() {
  try {


    const db = client.db('productsDB')
    const productsCollection = db.collection('products')
    const ordersCollection = db.collection('orders')
    const usersCollection = db.collection('users')


    // save a product data in db
    app.post('/products', async (req, res) => {
      const productData = req.body
      productData.showOnHome = false;
      const result = await productsCollection.insertOne(productData)
      res.send(result)
    })


    // get all products from db
    app.get('/products', async (req, res) => {
      const result = await productsCollection.find().toArray()
      res.send(result)
    })


    // new api Get all FEATURED products for the Home Page (MUST BE FIRST)
    app.get('/products/featured', async (req, res) => {
      const query = {
        $or: [
          { showOnHome: true },
          { showOnHome: "true" }
        ]
      };
      const result = await productsCollection.find(query).toArray();
      res.send(result);
    });


    // get product details
    app.get('/products/:id', async (req, res) => {
      const id = req.params.id
      const result = await productsCollection.findOne({ _id: new ObjectId(id) })
      res.send(result)
    })


    // payment related apis (✅ UPDATED: Total Price, Order Quantity & Delivery Info Handled)
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body
      console.log(paymentInfo)

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: paymentInfo?.name,
                description: `Order Quantity: ${paymentInfo?.orderQuantity}. Unit Price: $${paymentInfo?.price}. ${paymentInfo?.description}`,
                images: [paymentInfo?.image],
              },
              // মোট অর্ডার প্রাইস এখানে ইউনিট অ্যামাউন্ট হিসেবে পাঠানো হয়েছে
              unit_amount: paymentInfo?.totalPrice * 100,
            },
            quantity: 1, // টোটাল প্রাইস পাঠালে quantity 1 হবে
          },
        ],
        mode: 'payment',
        metadata: {
          productId: paymentInfo?.productId,
          buyer: paymentInfo?.buyer.email,
          // অর্ডার কোয়ান্টিটি এবং ডেলিভারি ডেটা মেটাডেটা হিসেবে পাঠানো হয়েছে
          orderQuantity: paymentInfo?.orderQuantity,
          deliveryInfo: JSON.stringify(paymentInfo?.deliveryInfo)
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/product/${paymentInfo?.productId}`,
      })

      res.send({ url: session.url })

    })


    // (✅ UPDATED: Dynamic Quantity & Delivery Info Handled)
    app.post('/payment-success', async (req, res) => {
      const { sessionId } = req.body
      const session = await stripe.checkout.sessions.retrieve(sessionId)

      const product = await productsCollection.findOne({ _id: new ObjectId(session.metadata.productId) })
      // মেটাডেটা থেকে ডাইনামিক অর্ডার কোয়ান্টিটি নিন
      const orderQuantity = parseInt(session.metadata.orderQuantity);
      // মেটাডেটা থেকে ডেলিভারি ইনফো পার্স করুন
      const deliveryInfo = JSON.parse(session.metadata.deliveryInfo);

      const order = await ordersCollection.findOne({ transactionId: session.payment_intent })


      if (session.status === 'complete' && product && !order) {
        // save order data in db
        const orderInfo = {
          productId: session.metadata.productId,
          transactionId: session.payment_intent,
          buyer: session.metadata.buyer,
          status: 'Pending',
          manager: product.manager,
          name: product.name,
          category: product.category,

          // অর্ডার quantity সেভ করুন
          orderQuantity: orderQuantity,
          // ডেলিভারি ইনফো সেভ করুন
          deliveryInfo: deliveryInfo,

          // টোটাল প্রাইস সেভ করুন
          price: session.amount_total / 100,
        }
        const result = await ordersCollection.insertOne(orderInfo)

        // update product available quantity
        await productsCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.productId),
          },
          // অর্ডার কোয়ান্টিটি অনুযায়ী মজুত কমানো হয়েছে
          { $inc: { availableQuantity: -orderQuantity } }
        )

        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,

        })
      }
      res.send(
        res.send({
          transactionId: session.payment_intent,
          orderId: order._id,

        })
      )
    })


    //api to get all orders with optional status filter for admin dashboard
    app.get('/all-orders', async (req, res) => {
      const { status } = req.query;

      let query = {};
      if (status) {
        query.status = status;
      }

      const options = {
        sort: { transactionId: -1 }
      };

      const result = await ordersCollection.find(query, options).toArray();
      res.send(result);
    });


    // get all orders for a buyer by email
    app.get('/my-orders/:email', async (req, res) => {
      const email = req.params.email
      const result = await ordersCollection.find({ buyer: email }).toArray()
      res.send(result)
    })

    // new api for track order
    app.get('/order/:orderId', async (req, res) => {
      const id = req.params.orderId

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid Order ID format" });
      }

      try {
        const query = { _id: new ObjectId(id) }
        const orderData = await ordersCollection.findOne(query);

        if (!orderData) {
          return res.status(404).send({ message: "Order not found" });
        }

        res.send(orderData);

      } catch (error) {
        console.error("Error fetching order:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    })

    // get api for approve orders
    app.get('/approve-orders/:email', async (req, res) => {
      const email = req.params.email
      const query = {
        'manager.email': email,
        status: 'Pending'
      }

      const result = await ordersCollection.find(query).toArray()
      res.send(result)
    })

    // get all plants for a manager by email
    app.get('/manage-product/:email', async (req, res) => {
      const email = req.params.email
      const result = await productsCollection.find({ 'manager.email': email }).toArray()
      res.send(result)
    })

    // api for Update a product by id
    app.put('/product/:id', async (req, res) => {
      const id = req.params.id
      const updatedProductData = req.body

      const query = { _id: new ObjectId(id) }

      const updateDoc = {
        $set: {
          ...updatedProductData,
        },
      }
      const result = await productsCollection.updateOne(query, updateDoc)
      res.send(result)
    })

    // new api delete a product by id
    app.delete('/product/:id', async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const result = await productsCollection.deleteOne(query)

      res.send(result)
    })

    // api for Update Order Status by id
    app.put('/order-status/:id', async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      let updateFields = { status };

      if (status === 'Approved') {
        updateFields.approvedAt = new Date();
      }
      else if (status === 'Rejected') {
        updateFields.approvedAt = null;
      }
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: updateFields,
      };
      const result = await ordersCollection.updateOne(query, updateDoc);

      res.send(result);
    });

    //  api to get all approved orders for a manager by email
    app.get('/approved-orders/:email', async (req, res) => {
      const email = req.params.email
      const query = {
        'manager.email': email,
        status: 'Approved'
      }
      const options = {
        sort: { approvedAt: -1 }
      };
      const result = await ordersCollection.find(query, options).toArray()
      res.send(result)
    })

    // api to add tracking Information to an order 
    app.put('/order-tracking/:id', async (req, res) => {
      const id = req.params.id;
      const trackingData = req.body;

      const newTrackingEntry = {
        ...trackingData,
        timestamp: new Date(),
      };
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $push: { tracking: newTrackingEntry },
        $set: {
          currentTrackingStatus: trackingData.status,
          updatedAt: new Date()
        }
      };
      const result = await ordersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // api to get all users
    app.get('/users', async (req, res) => {

      const adminEmail = req.user?.email; 

      let query;

      if (adminEmail) {
        query = {
          $and: [
            { role: { $ne: 'admin' } },
            { email: { $ne: adminEmail } }
          ]
        };
      } else {
        query = { role: { $ne: 'admin' } };
      }

      const result = await usersCollection.find(query).toArray();

      res.send(result);
    });

    // api to Update User Role and Status by id
    app.put('/user/:id', async (req, res) => {
      const id = req.params.id;
      const updatedUserData = req.body;

      // ⚠️ Optional: Admin check middleware ekhane use kora uchit

      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: updatedUserData.role,
          status: updatedUserData.status,
          suspendReason: updatedUserData.suspendReason,
          suspendFeedback: updatedUserData.suspendFeedback,
          updated_at: new Date().toISOString(),
        },
      };
      const result = await usersCollection.updateOne(query, updateDoc);

      res.send(result);
    });

    // save or update a user in db
    app.post('/user', async (req, res) => {
      const userData = req.body
      userData.created_at = new Date().toISOString()
      userData.last_loggedIn = new Date().toISOString()
      userData.role = 'buyer'
      userData.status = 'pending'

      const query = {
        email: userData.email,
      }
      const alreadyExists = await usersCollection.findOne(query)
      console.log('User Already Exists----->', !!alreadyExists)
      if (alreadyExists) {
        console.log('Updating user info......')
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          }
        })
        res.send(result)
        return
      }

      console.log('Saving new user info......')
      const result = await usersCollection.insertOne(userData)
      res.send(result)
    })

    // get a user's role
    app.get('/user/role/:email', async (req, res) => {
      const email = req.params.email
      const result = await usersCollection.findOne({ email })
      res.send({ role: result?.role })
    })

    // api for toggle Product Visibility on Home Page
    app.put('/products/toggle-home/:id', async (req, res) => {
      // ⚠️ Ekhane Admin verification middleware add kora uchit

      const id = req.params.id;
      const { showOnHome } = req.body;
      if (typeof showOnHome !== 'boolean') {
        return res.status(400).send({ message: 'Invalid value for showOnHome (must be boolean)' });
      }
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          showOnHome: showOnHome,
          updatedAt: new Date(),
        },
      };

      const result = await productsCollection.updateOne(query, updateDoc);

      res.send(result);
    });

    // 🔥 নতুন API: ড্যাশবোর্ডের জন্য অ্যাডমিন পরিসংখ্যান (Admin Statistics)
    app.get('/stats/admin', async (req, res) => {
      // ⚠️ এখানে Admin Role verification middleware যোগ করা উচিত
      // উদাহরণস্বরূপ: app.get('/stats/admin', verifyJWT, verifyAdmin, async (req, res) => { ... })
      
      try {
        // ১. মোট ব্যবহারকারী গণনা (Total Users)
        // সাধারণত, অ্যাডমিন স্ট্যাটসে শুধু নন-অ্যাডমিন ইউজারদের গণনা করা হয়।
        const totalUsers = await usersCollection.countDocuments({ role: { $ne: 'admin' } });

        // ২. মোট অর্ডার গণনা (Total Orders)
        const totalOrders = await ordersCollection.countDocuments();
        
        // ৩. মোট প্রোডাক্ট গণনা (Total Products)
        const totalProducts = await productsCollection.countDocuments();

        // ৪. মোট বিক্রয় গণনা (Total Sales) - Aggregation Pipeline ব্যবহার করে
        // যদি sales data না থাকে, তাহলে এটি বাদ দিতে পারেন
        const salesResult = await ordersCollection.aggregate([
          {
            $group: {
              _id: null,
              totalSales: { $sum: '$price' }, // 'price' ফিল্ডটি প্রতি অর্ডারের টোটাল প্রাইস ধরে রাখছে বলে ধরে নেওয়া হলো
            },
          },
        ]).toArray();
        
        const totalSales = salesResult.length > 0 ? salesResult[0].totalSales : 0;
        
        // সব ডেটা একটি অবজেক্টে পাঠিয়ে দেওয়া
        res.send({
          totalOrders,
          totalProducts,
          totalUsers,
          totalSales: parseFloat(totalSales.toFixed(2)), // দশমিকের পর দুটি সংখ্যা রাখা হলো
        });

      } catch (error) {
        console.error("Error fetching admin stats:", error);
        res.status(500).send({ message: 'Internal Server Error', error: error.message });
      }
    });

    // 🔥 নতুন API: ম্যানেজারের পরিসংখ্যান (Manager Statistics)
    // ম্যানেজারের ইমেইল ব্যবহার করে তাদের মোট প্রোডাক্ট, অর্ডার, ও সেলস গণনা করা হবে।
    app.get('/stats/manager/:email', async (req, res) => {
        const email = req.params.email;
        
        // ⚠️ এখানে JWT verification এবং Manager Role verification middleware যোগ করা উচিত
        // যেন শুধু লগইন করা ম্যানেজারই তার ডেটা দেখতে পারে। 
        // আপনি verifyJWT middleware ব্যবহার করতে পারেন: app.get('/stats/manager/:email', verifyJWT, async (req, res) => { ... })
        // এবং নিশ্চিত করুন req.tokenEmail এবং email মেলে। 
        
        try {
            // ১. ম্যানেজারের মোট প্রোডাক্ট (Total Products) গণনা
            const totalProducts = await productsCollection.countDocuments({ 'manager.email': email });

            // ২. ম্যানেজারের প্রোডাক্টের উপর আসা মোট অর্ডার (Total Orders) গণনা
            const totalOrders = await ordersCollection.countDocuments({ 'manager.email': email });

            // ৩. ম্যানেজারের মোট অনুমোদিত অর্ডার (Total Approved Orders) গণনা
            const totalApprovedOrders = await ordersCollection.countDocuments({ 
                'manager.email': email, 
                status: 'Approved' 
            });

            // ৪. ম্যানেজারের মোট বিক্রয় (Total Revenue) গণনা (শুধুমাত্র Approved অর্ডার থেকে)
            const revenueResult = await ordersCollection.aggregate([
                {
                    $match: {
                        'manager.email': email,
                        status: 'Approved'
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalRevenue: { $sum: '$price' }, // 'price' হলো মোট অর্ডারের দাম
                    },
                },
            ]).toArray();
            
            const totalRevenue = revenueResult.length > 0 ? revenueResult[0].totalRevenue : 0;
            
            // সব ডেটা একটি অবজেক্টে পাঠিয়ে দেওয়া
            res.send({
                totalProducts,
                totalOrders,
                totalApprovedOrders,
                totalRevenue: parseFloat(totalRevenue.toFixed(2)),
            });

        } catch (error) {
            console.error("Error fetching manager stats:", error);
            res.status(500).send({ message: 'Internal Server Error', error: error.message });
        }
    });

    // ... (অন্যান্য API-এর পর)
    
    // 🔥 নতুন API: ক্রেতার পরিসংখ্যান (Buyer Statistics)
    // ক্রেতার ইমেইল ব্যবহার করে তার মোট অর্ডার, স্ট্যাটাস এবং খরচ গণনা করা হবে।
    app.get('/stats/buyer/:email', async (req, res) => {
        const email = req.params.email;
        
        // ⚠️ এখানে JWT verification middleware যোগ করা উচিত
        // app.get('/stats/buyer/:email', verifyJWT, async (req, res) => { ... })
        // এবং নিশ্চিত করুন req.tokenEmail এবং email মেলে।
        
        try {
            // ১. ক্রেতার মোট অর্ডার (Total Orders) গণনা
            const totalOrders = await ordersCollection.countDocuments({ buyer: email });

            // ২. মোট Pending অর্ডার গণনা
            const pendingOrders = await ordersCollection.countDocuments({ 
                buyer: email, 
                status: 'Pending' 
            });

            // ৩. মোট Approved অর্ডার গণনা
            const approvedOrders = await ordersCollection.countDocuments({ 
                buyer: email, 
                status: 'Approved' 
            });

            // ৪. মোট খরচ (Total Spending) গণনা (শুধুমাত্র Approved অর্ডার থেকে)
            const spendingResult = await ordersCollection.aggregate([
                {
                    $match: {
                        buyer: email,
                        status: 'Approved'
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalSpending: { $sum: '$price' }, 
                    },
                },
            ]).toArray();
            
            const totalSpending = spendingResult.length > 0 ? spendingResult[0].totalSpending : 0;
            
            // সব ডেটা একটি অবজেক্টে পাঠিয়ে দেওয়া
            res.send({
                totalOrders,
                pendingOrders,
                approvedOrders,
                totalSpending: parseFloat(totalSpending.toFixed(2)),
            });

        } catch (error) {
            console.error("Error fetching buyer stats:", error);
            res.status(500).send({ message: 'Internal Server Error', error: error.message });
        }
    });


    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('Garment Track server is running')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})